// src/client/text-script.ts —— WE text 脚本（text.script 的 update）的 quickjs 沙箱运行时。
// 只执行 update(value)；沙箱内拿不到 DOM/window/fetch，且有步数上限防死循环。
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
// 单次调用（eval/update）的指令预算：正常脚本远低于此；死循环在此被中断。
const STEP_BUDGET = 1_000_000;
// WE 注入的 scriptProperties builder。宽松实现：未知 add* 方法登记后返回自身、不崩；
// finish() = {...builder 默认值, ...scene.json 的 scriptproperties}（注入值优先，见 spec §2.3）。
const PRELUDE = `
function createScriptProperties() {
  var injected = (typeof __weScriptProps === 'object' && __weScriptProps) ? __weScriptProps : {};
  var defaults = {};
  var api = {
    addCheckbox: add, addSlider: add, addComboBox: add, addColor: add,
    addText: add, addTextInput: add, addFont: add, addUserProperty: add,
    finish: function () { return Object.assign({}, defaults, injected); }
  };
  function add(o) { if (o && o.name) defaults[o.name] = o.value; return api; }
  return api;
}
true;
`;
class QuickJSTextRuntime {
    ctx;
    runtime;
    budget = 0;
    constructor(ctx, runtime) {
        this.ctx = ctx;
        this.runtime = runtime;
    }
    resetBudget() {
        this.budget = STEP_BUDGET;
    }
    /** interrupt handler 每执行一批指令调一次：递减预算。 */
    step() {
        this.budget -= 1000;
    }
    /** 预算耗尽 → 让 quickjs 中断当前脚本（抛 interrupt 错误）。 */
    outOfBudget() {
        return this.budget <= 0;
    }
    bind(script, scriptProperties, initialValue) {
        if (typeof script !== 'string' || !script)
            return null;
        const ctx = this.ctx;
        this.resetBudget();
        // 注入 scene.json 的 scriptproperties（{user,value} 包装已在 parseScriptProperties 解包）
        const props = ctx.newObject();
        for (const [key, value] of Object.entries(scriptProperties ?? {})) {
            if (typeof value === 'boolean')
                ctx.setProp(props, key, value ? ctx.true : ctx.false);
            else if (typeof value === 'number')
                ctx.setProp(props, key, ctx.newNumber(value));
            else if (typeof value === 'string')
                ctx.setProp(props, key, ctx.newString(value));
        }
        ctx.setProp(ctx.global, '__weScriptProps', props);
        // 剥 export + IIFE 隔离（各脚本的 update/addCero 等标识符互不冲突）
        const sanitized = script.replace(/\bexport\s+/g, '');
        const r = ctx.evalCode(`(function(){ ${PRELUDE} ${sanitized}
        return (typeof update === 'function') ? { update: update } : null;
      })()`);
        if (r.error) {
            r.error.dispose();
            props.dispose();
            return null;
        }
        const mod = r.value;
        if (ctx.typeof(mod) !== 'object' || ctx.dump(mod) === null) {
            mod.dispose();
            props.dispose();
            return null;
        }
        const updateFn = ctx.getProp(mod, 'update');
        if (ctx.typeof(updateFn) !== 'function') {
            updateFn.dispose();
            mod.dispose();
            props.dispose();
            return null;
        }
        let last = initialValue ?? '';
        let disposed = false;
        return {
            update: () => {
                if (disposed)
                    return null;
                this.resetBudget();
                const arg = ctx.newString(last);
                const out = ctx.callFunction(updateFn, ctx.undefined, arg);
                arg.dispose();
                if (out.error) {
                    out.error.dispose();
                    return null; // 单脚本抛错/被中断 → 只停该脚本
                }
                const v = ctx.dump(out.value);
                out.value.dispose();
                last = typeof v === 'string' ? v : String(v ?? '');
                return last;
            },
            dispose: () => {
                if (disposed)
                    return;
                disposed = true;
                ctx.setProp(ctx.global, '__weScriptProps', ctx.undefined);
                updateFn.dispose();
                mod.dispose();
                props.dispose();
            },
        };
    }
    dispose() {
        try {
            this.ctx.dispose();
        }
        catch { /* noop */ }
        try {
            this.runtime.dispose();
        }
        catch { /* gc 断言可忽略 */ }
    }
}
// 模块级单例：整页只实例化一次 QuickJS（跨壁纸复用，见 spec §3.3）。
let runtimePromise = null;
// 浏览器：wasm 由 host 的 /wallpapers/static/ 提供（build:client 复制到 dist/static/quickjs.wasm）；
// Node 测试环境无 window → 交给库默认定位（fs 读取）。
function createQuickJSModule() {
    const wasmLocation = typeof window !== 'undefined' ? '/wallpapers/static/quickjs.wasm' : undefined;
    return newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, wasmLocation ? { wasmLocation } : {}));
}
async function createRuntime() {
    try {
        const QuickJS = await createQuickJSModule();
        const runtime = QuickJS.newRuntime();
        // 中断处理器必须在 newContext 之前注册：闭包经 self 拿到实例后递减预算。
        let self = null;
        runtime.setInterruptHandler(() => {
            if (!self)
                return false;
            self.step();
            return self.outOfBudget();
        });
        const ctx = runtime.newContext();
        const pre = ctx.evalCode(PRELUDE);
        if (pre.error) {
            pre.error.dispose();
            ctx.dispose();
            runtime.dispose();
            return null;
        }
        pre.value.dispose();
        self = new QuickJSTextRuntime(ctx, runtime);
        return self;
    }
    catch {
        return null;
    }
}
export async function getTextScriptRuntime() {
    runtimePromise ??= createRuntime();
    return runtimePromise;
}
/** 单测用：丢弃单例（不销毁已建实例）。 */
export function resetTextScriptRuntimeForTest() {
    runtimePromise = null;
}
