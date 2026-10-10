// src/client/text-script.ts —— WE text 脚本（text.script 的 update）的 quickjs 沙箱运行时。
// 只执行 update(value)；沙箱内拿不到 DOM/window/fetch，且有步数上限防死循环。
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
// 单次调用（eval/update）的指令预算：正常脚本远低于此；死循环在此被中断。
const STEP_BUDGET = 1_000_000;
// WE 注入的 scriptProperties builder。`finish()` = {...builder 默认值, ...scene.json 的
// scriptproperties}（注入值优先，见 spec §2.3）。
// ⚠️ **不能只列方法名表**：WE 的 builder 方法名以 `add` 开头且有一长串长尾
// （OWE `Script.cpp:1200-1214`：Slider / Checkbox / Text / Combo / Color / Delimiter +
// Animation / Interpolator / AniMapper / Task / ChangedUserProperty / Listener /
// SpaceToTimeDelimiter / SpaceToDateDelimiter / Value）。此前只注册了 8 个名字、且把官方的
// `addCombo` 错写成不存在的 `addComboBox` ⇒ 用 `addCombo` 的脚本（Spider Man 4K 的
// 「DAY」「DATE」、Crimson Horizon 的日期等）eval 直接 `TypeError: not a function`
// ⇒ bind 返回 null ⇒ 整个文本层被跳过（2026-09-30 用户报告）。
// 现改为 Proxy 兜底任意 `add*`：登记 name/value 后返回自身，链式 `.addX().addY().finish()` 不断。
const PRELUDE = `
function createScriptProperties() {
  var injected = (typeof __weScriptProps === 'object' && __weScriptProps) ? __weScriptProps : {};
  var defaults = {};
  var proxy = null;
  function add(o) { if (o && o.name) defaults[o.name] = o.value; return proxy; }
  var api = {
    finish: function () { return Object.assign({}, defaults, injected); }
  };
  proxy = new Proxy(api, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && k.indexOf('add') === 0) return add;
      return undefined;
    }
  });
  return proxy;
}
// WE 脚本里的 import 导入的是**引擎注入的 WE 模块**（WEMath / WEColor / WEVector …），不是文件。
// 这里只提供最低限度的「不崩」shim：命名空间是 object、点出来的成员是可调用的 noop（返回
// undefined）。真实成员未实现 —— 用了它的脚本会把 'undefined' 画进文本层，但仍**好过整段 bind
// 失败导致整层文本消失**（魔兽之门 #778 的 import 甚至没被用到）。将来要真实现只需在这里加成员。
function __weModule(name) {
  var noop = function () { return undefined; };
  return new Proxy({}, {
    get: function (t, k) { if (k === '__weModuleName') return name; return noop; }
  });
}
true;
`;
// WE 模块 import 语句 → 本地绑定：
//   import * as WEMath from 'WEMath'  ⇒ var WEMath = __weModule('WEMath');
//   import { clamp } from 'WEMath'    ⇒ var clamp = __weModule('WEMath').clamp;
// 为什么必须转写：脚本被包进 `(function(){ … })()` 执行，而 **import 语句不能出现在函数体内**
// ⇒ QuickJS 报 `expecting '('` ⇒ bind 返回 null ⇒ 整层文本被跳过（魔兽之门 1922570576 的 #778
// 「3D Clock」就是这么消失的：它的 import 是纯声明、脚本体根本没引用）。只匹配行首的 import
// 语句（带引号模块名），字符串 / 注释里的同形文本不会被改写。
function rewriteWeModuleImports(script) {
    let out = script.replace(/^[ \t]*import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2[ \t]*;?/gm, "var $1 = __weModule('$3');");
    out = out.replace(/^[ \t]*import\s*\{([^{}]*)\}\s*from\s+(['"])([^'"]+)\2[ \t]*;?/gm, (_m, names, _q, mod) => names
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .map((spec) => {
        // `a as b` → 绑到本地名 b
        const parts = spec.split(/\s+as\s+/).map((s) => s.trim());
        const imported = parts[0];
        const local = parts[1] ?? imported;
        return `var ${local} = __weModule('${mod}').${imported};`;
    })
        .join(' '));
    return out;
}
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
        // 剥 export + 转写 WE 模块 import + IIFE 隔离（各脚本的 update/addCero 等标识符互不冲突）
        const sanitized = rewriteWeModuleImports(script.replace(/\bexport\s+/g, ''));
        const r = ctx.evalCode(`(function(){ ${PRELUDE} ${sanitized}
        return (typeof update === 'function') ? { update: update } : null;
      })()`);
        if (r.error) {
            // 诊断可见性（2026-09-30）：此前静默返回 null，导致「脚本 bind 失败 → 文本层整层消失」
            // 只能靠外部探针复现（Spider Man 4K 的 DAY/DATE 就是这么消失的）。只打一条 warn，不抛。
            const info = ctx.dump(r.error);
            console.warn('[text-script] 脚本执行失败，该文本层将回退/跳过：', info?.message ?? String(info));
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
        let warned = false;
        return {
            update: () => {
                if (disposed)
                    return null;
                this.resetBudget();
                const arg = ctx.newString(last);
                const out = ctx.callFunction(updateFn, ctx.undefined, arg);
                arg.dispose();
                if (out.error) {
                    if (!warned) {
                        warned = true; // 每帧调用，只报一次（脚本可能每帧都抛）
                        const info = ctx.dump(out.error);
                        console.warn('[text-script] update 抛错/超时，保持上一帧文本：', info?.message ?? String(info));
                    }
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
