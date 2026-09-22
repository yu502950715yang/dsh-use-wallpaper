// src/client/scene-script-vm.ts
//
// WE SceneScript（模块风格）的 quickjs 运行时：**单一 ctx** 装载 N 个脚本 —— 它们靠同一个全局
// `shared` 互通（3798688689 的 4 个总控就靠 shared.we2dScene / we2dTransition / we2dFx 传递状态，
// 分散到多个 ctx 会静默失效）。
//
// 分工：宿主只注入少量原语（read/write/anim*/frametime/log），图层对象与 thisScene / engine /
// Vec3 / IModelData 全部由 PRELUDE 在 quickjs 内构造 —— 状态始终留在宿主的 LayerStateTable 与
// AnimRegistry 里，本模块不依赖 three。
//
// ⚠️ handle 生命周期：newFunction / getProp / newObject 产生的堆句柄必须 dispose，否则
// runtime.dispose() 会触发 quickjs 的 gc_obj_list 断言（上一轮 spike 实测踩到）。本类把所有长期
// 句柄收在 `handles` 里，dispose() 统一释放。
import { newQuickJSWASMModuleFromVariant, newVariant, RELEASE_SYNC } from 'quickjs-emscripten';
// 单脚本一次调用的指令预算：正常脚本远低于此；死循环在此被中断。
const STEP_BUDGET = 50_000_000;
// prelude：在 quickjs 全局作用域定义宿主 API 与 WE 内置类型。所有状态都在宿主的 state/anims。
// `engine.frametime` 用 getter 走宿主原语 —— 避免每帧新建 number 句柄。
const PRELUDE = `
var __mods = [];

function Vec3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
function Vec4(x, y, z, w) { this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = w || 0; }
var IModelData = { POSITION: 0, UV: 1, COLOR: 2, NORMAL: 3, TANGENT: 4 };

function __noop() {}

// 万能兜底：**未实现的 WE API 一律返回「可调用的 Proxy」**，避免单个缺失方法就让整个脚本
// 被停用（实测：221591「双击切歌」的 thisScene.getLayer(name).stop() 就是这种；没有兜底时
// init 直接 TypeError 并停用该脚本）。属性读取给安全默认值（alpha=1 / visible=true / 位移 0）。
var __anyCache = {};
function __any(path) {
  if (__anyCache[path]) return __anyCache[path];
  var p = new Proxy(function () {}, {
    get: function (t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'toString' || prop === 'valueOf') return function () { return 0; };
      if (prop === 'alpha' || prop === 'opacity' || prop === 'brightness' || prop === 'baseAlpha') return 1;
      if (prop === 'visible' || prop === 'active' || prop === 'shown' || prop === 'isPlaying') return true;
      if (prop === 'x' || prop === 'y' || prop === 'z' || prop === 'w' || prop === 'h' || prop === 'rot') return 0;
      return __any(path + '.' + String(prop));
    },
    set: function () { return true; },
    apply: function () { return __any(path + '()'); }
  });
  __anyCache[path] = p;
  return p;
}
// 已知成员走显式实现（getter 正常触发），未知成员退回 __any。
function __wrap(base, path) {
  return new Proxy(base, {
    get: function (t, prop) {
      if (typeof prop === 'symbol') return undefined;
      return (prop in t) ? t[prop] : __any(path + '.' + String(prop));
    },
    set: function (t, prop, v) { t[prop] = v; return true; }
  });
}

function __mkDummy(name) {
  return __wrap({
    __dummyName: name,
    applyData: __noop, setParent: __noop, setMaterialProperty: __noop,
    getMaterialProperty: function () { return 0; }, visible: true
  }, 'dummy(' + name + ')');
}

var __animCache = {};
function __mkAnim(key, name) {
  var k = key + '|' + name;
  if (__animCache[k]) return __animCache[k];
  __animCache[k] = {
    play: function () { __host.animPlay(key, name); },
    pause: function () { __host.animPause(key, name); },
    stop: function () { __host.animStop(key, name); },
    isPlaying: function () { return __host.animIsPlaying(key, name); },
    setFrame: function (v) { __host.animSetFrame(key, name, v); },
    getFrame: function () { return __host.animGetFrame(key, name); }
  };
  return __animCache[k];
}

var __layerCache = {};
function __mkLayer(key) {
  if (__layerCache[key]) return __layerCache[key];
  var path = 'layer(' + key + ')';
  var o = {
    __key: key,
    get alpha() { return __host.readNum(key, 'alpha'); },
    set alpha(v) { __host.writeNum(key, 'alpha', v); },
    get baseAlpha() { return __host.readNum(key, 'baseAlpha'); },
    set baseAlpha(v) { __host.writeNum(key, 'baseAlpha', v); },
    get opacity() { return __host.readNum(key, 'opacity'); },
    set opacity(v) { __host.writeNum(key, 'opacity', v); },
    get visible() { return __host.readBool(key, 'visible'); },
    set visible(v) { __host.writeBool(key, 'visible', v); },
    get shown() { return __host.readBool(key, 'visible'); },
    set shown(v) { __host.writeBool(key, 'visible', v); },
    get origin() { var a = __host.readVec(key, 'origin'); return new Vec3(a[0], a[1], a[2]); },
    set origin(v) { __host.writeVec(key, 'origin', v.x, v.y, (v.z === undefined ? 0 : v.z)); },
    get angles() { var a = __host.readVec(key, 'angles'); return new Vec3(a[0], a[1], a[2]); },
    set angles(v) { __host.writeVec(key, 'angles', v.x, v.y, (v.z === undefined ? 0 : v.z)); },
    get scale() { var a = __host.readVec(key, 'scale'); return new Vec3(a[0], a[1], a[2]); },
    set scale(v) { __host.writeVec(key, 'scale', v.x, v.y, (v.z === undefined ? 1 : v.z)); },
    get color() { var a = __host.readVec(key, 'color'); return new Vec3(a[0], a[1], a[2]); },
    set color(v) { __host.writeVec(key, 'color', v.x, v.y, (v.z === undefined ? 0 : v.z)); },
    getAnimation: function (name) { return __mkAnim(key, String(name)); },
    getEffect: function (name) {
      return __wrap({ name: name, visible: true, setMaterialProperty: __noop, getMaterialProperty: function () { return 0; } }, path + '.fx(' + name + ')');
    },
    getModelData: function () { return __mkDummy('model'); },
    setMaterialProperty: __noop,
    getMaterialProperty: function () { return 0; },
    setParent: __noop,
    setVisible: function (v) { __host.writeBool(key, 'visible', v); return v; }
  };
  __layerCache[key] = __wrap(o, path);
  return __layerCache[key];
}

// 运行时图层（脚本 createLayer 建的动态网格层）：visible 读写走宿主，其余方法走兜底。
var __rtLayerCache = {};
function __mkRuntimeLayer(id) {
  if (__rtLayerCache[id]) return __rtLayerCache[id];
  var o = {
    __layerId: id,
    alpha: 1, baseAlpha: 1, opacity: 1,
    get visible() { return __host.layerVisible(id); },
    set visible(v) { __host.setLayerVisible(id, !!v); },
    get shown() { return __host.layerVisible(id); },
    set shown(v) { __host.setLayerVisible(id, !!v); },
    getAnimation: function (n) { return __mkAnim('rtlayer:' + id, String(n)); },
    getEffect: function () { return { visible: true, setMaterialProperty: __noop, getMaterialProperty: function () { return 0; } }; },
    getModelData: function () { return __mkDummy('model'); },
    setMaterialProperty: __noop,
    getMaterialProperty: function () { return 0; },
    setParent: __noop,
    setVisible: function (v) { __host.setLayerVisible(id, !!v); return v; }
  };
  __rtLayerCache[id] = __wrap(o, 'rtlayer(' + id + ')');
  return __rtLayerCache[id];
}

var thisScene = __wrap({
  getLayerByID: function (id) { return __mkLayer('id:' + id); },
  getLayer: function (n) { return __mkLayer('name:' + n); },
  // 动态网格（2026-09-22）：真实的 createModelData / createLayer 桥。脚本只透传句柄 ——
  // 模型句柄带 __modelId、图层句柄带 __layerId；顶点每帧经 __host.applyMeshData 上传。
  createModelData: function (o) {
    var s = (o && o.shapes && o.shapes[0]) || {};
    var vb = s.vertexBuffer;
    var capacity = vb ? Math.floor(vb.length / 36) : 0; // 每 quad 36 floats（9 floats/顶点 × 4）
    var mat = (s.material && s.material.__assetPath) ? s.material.__assetPath : null;
    var id = __host.createModel({ capacity: capacity, vertexFormat: s.vertexFormat, materialPath: mat });
    return {
      __modelId: id,
      applyData: function (d) {
        var v = (d && d.vertexBuffer) ? d.vertexBuffer : vb;
        if (v && v.buffer) __host.applyMeshData(id, v.buffer);
      }
    };
  },
  createLayer: function (o) {
    var mid = (o && o.model && o.model.__modelId !== undefined) ? o.model.__modelId : -1;
    var lid = __host.createLayer(mid, String((o && o.name) || 'anon'));
    return __mkRuntimeLayer(lid);
  }
}, 'thisScene');
var getLayerByID = thisScene.getLayerByID;
var getLayer = thisScene.getLayer;
var createLayer = thisScene.createLayer;

var engine = __wrap({
  userProperties: {},
  registerAsset: function (p) { __host.registerAsset(String(p)); return { __assetPath: String(p) }; },
  get frametime() { return __host.frametime(); }
}, 'engine');
var registerAsset = engine.registerAsset;

var shared = {};
var console = { log: __host.log, warn: __host.log, error: __host.log };
true;
`;
export class SceneScriptVm {
    ctx;
    runtime;
    handles = [];
    modules = [];
    animCache = new Map();
    state;
    anims;
    onWarn;
    /** 动态网格注册表（createModelData/createLayer/applyData 的真实落点）；缺省 = stub 行为。 */
    mesh;
    /** engine.registerAsset 的回调（装载期用它解析材质资产路径）。 */
    onAsset;
    dt = 1 / 60;
    /** 单次脚本调用的指令预算（缺省 STEP_BUDGET；callOne 每次调用前重置）。 */
    stepBudget;
    budget;
    constructor(ctx, runtime, opts) {
        this.ctx = ctx;
        this.runtime = runtime;
        this.state = opts.state;
        this.anims = opts.anims;
        this.onWarn = opts.onWarn ?? (() => { });
        this.mesh = opts.dynamicMesh ?? null;
        this.onAsset = opts.onAsset ?? null;
        this.stepBudget = Number.isFinite(opts.stepBudget) && opts.stepBudget > 0
            ? opts.stepBudget
            : STEP_BUDGET;
        this.budget = this.stepBudget;
    }
    /** 初始化 quickjs 并装好 prelude。失败返回 null（调用方退回"无脚本"路径，画面等于现状）。 */
    static async create(opts) {
        let runtime = null;
        try {
            // ⚠️ 浏览器必须显式给出 wasm 位置：库默认按 JS 自身 URL 推导，打包进 client.js 后会 404
            // （表现为 console 一串 "wasm streaming compile failed" 而脚本静默不执行 —— 只有 e2e 能发现）。
            // 与 text-script.ts 同源：host 把 quickjs.wasm 放在 /wallpapers/static/。
            const wasmLocation = typeof window !== 'undefined' ? '/wallpapers/static/quickjs.wasm' : undefined;
            const mod = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, wasmLocation ? { wasmLocation } : {}));
            runtime = mod.newRuntime();
            runtime.setMemoryLimit(1024 * 1024 * 1024);
            runtime.setMaxStackSize(4 * 1024 * 1024);
            const ctx = runtime.newContext();
            const vm = new SceneScriptVm(ctx, runtime, opts);
            // ⚠️ 指令预算必须**每次脚本调用前重置**（见 callOne）：只减不增的话，长时间运行后预算耗尽
            // 会让所有脚本被永久中断 —— 实测 GUI 跑一会儿后报 `InternalError: interrupted`
            // （headless e2e 只跑几帧，测不出来）。与 text-script.ts 的 resetBudget 同语义。
            runtime.setInterruptHandler(() => {
                vm.budget -= 10_000;
                return vm.budget <= 0;
            });
            if (!vm.installPrelude(opts)) {
                vm.dispose();
                return null;
            }
            return vm;
        }
        catch {
            try {
                runtime?.dispose();
            }
            catch { /* noop */ }
            return null;
        }
    }
    keep(h) {
        this.handles.push(h);
        return h;
    }
    warn(msg) {
        this.onWarn(msg);
    }
    installPrelude(opts) {
        const ctx = this.ctx;
        const host = ctx.newObject();
        this.handles.push(host);
        const define = (name, impl) => {
            const fn = ctx.newFunction(name, (...args) => impl(...args));
            ctx.setProp(host, name, fn);
            this.handles.push(fn);
        };
        // 读：未登记的图层给"不透明可见、缩放 1"的安全默认（脚本会读 baseAlpha/alpha 做判断）
        define('readNum', (k, p) => {
            const prop = ctx.getString(p);
            const w = this.state.read(this.keyOf(k));
            const v = w[prop];
            if (typeof v === 'number')
                return ctx.newNumber(v);
            return ctx.newNumber(prop === 'scale' ? 1 : prop === 'color' ? 1 : 1);
        });
        define('readBool', (k) => {
            const w = this.state.read(this.keyOf(k));
            return w.visible === false ? ctx.false : ctx.true;
        });
        define('readVec', (k, p) => {
            const prop = ctx.getString(p);
            const v = this.state.read(this.keyOf(k))[prop];
            const arr = v ?? (prop === 'scale' || prop === 'color' ? [1, 1, 1] : [0, 0, 0]);
            const out = ctx.newArray();
            for (let i = 0; i < 3; i++) {
                const h = ctx.newNumber(arr[i] ?? 0);
                ctx.setProp(out, i, h);
                h.dispose();
            }
            return out;
        });
        define('writeNum', (k, p, v) => {
            const prop = ctx.getString(p);
            const num = ctx.getNumber(v);
            const patch = prop === 'alpha' || prop === 'opacity' || prop === 'baseAlpha'
                ? { alpha: num }
                : {};
            this.write(this.keyOf(k), patch);
        });
        define('writeBool', (k, _p, v) => {
            this.write(this.keyOf(k), { visible: ctx.dump(v) === true });
        });
        define('writeVec', (k, p, x, y, z) => {
            const prop = ctx.getString(p);
            const arr = [ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z)];
            const patch = prop === 'scale' ? { scale: arr }
                : prop === 'origin' ? { origin: arr }
                    : prop === 'angles' ? { angles: arr }
                        : prop === 'color' ? { color: arr } : {};
            this.write(this.keyOf(k), patch);
        });
        // 动画标识用**原始 key 字符串**（`id:10750`），不是解析出的 scene 对象 id —— 播放器注册表
        // 按 (layerKey, name) 持久化，同名图层不同对象必须互不串台。
        define('animPlay', (k, n) => { this.anim(ctx.getString(k), ctx.getString(n)).play(); });
        define('animPause', (k, n) => { this.anim(ctx.getString(k), ctx.getString(n)).pause(); });
        define('animStop', (k, n) => { this.anim(ctx.getString(k), ctx.getString(n)).stop(); });
        define('animIsPlaying', (k, n) => (this.anim(ctx.getString(k), ctx.getString(n)).isPlaying() ? ctx.true : ctx.false));
        define('animSetFrame', (k, n, v) => { this.anim(ctx.getString(k), ctx.getString(n)).setFrame(ctx.getNumber(v)); });
        define('animGetFrame', (k, n) => ctx.newNumber(this.anim(ctx.getString(k), ctx.getString(n)).getFrame()));
        define('frametime', () => ctx.newNumber(this.dt));
        define('log', () => { });
        // ── 动态网格原语（2026-09-22）：createModelData / createLayer / applyData 的真实落点。
        //    未注入 registry 时全部退化为安全空操作（其他壁纸零影响）。──
        define('registerAsset', (pH) => { this.onAsset?.(ctx.getString(pH)); });
        define('createModel', (specH) => {
            if (!this.mesh)
                return ctx.newNumber(-1);
            const spec = ctx.dump(specH);
            const id = this.mesh.createModel({
                capacity: Number(spec?.capacity ?? 0),
                vertexFormat: Array.isArray(spec?.vertexFormat) ? spec.vertexFormat : [],
                materialPath: typeof spec?.materialPath === 'string' ? spec.materialPath : null,
            });
            return ctx.newNumber(id === null ? -1 : id);
        });
        define('createLayer', (modelH, nameH) => {
            if (!this.mesh)
                return ctx.newNumber(-1);
            return ctx.newNumber(this.mesh.createLayer(ctx.getNumber(modelH), ctx.getString(nameH)));
        });
        // 顶点上传：quickjs 的 ArrayBuffer → 宿主 Float32Array 视图。
        // ⚠️ getArrayBuffer 返回的是 `_Lifetime{ value: Uint8Array }`（wasm 内存视图，byteOffset 非 0），
        // 不是 Uint8Array 本身 —— 必须经 `.value` 取，并用 (buffer, byteOffset, len) 建视图。
        define('applyMeshData', (modelH, bufH) => {
            if (!this.mesh)
                return;
            try {
                const lifetime = ctx.getArrayBuffer(bufH);
                try {
                    const bytes = lifetime.value;
                    const f32 = bytes.byteOffset % 4 === 0
                        ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
                        : new Float32Array(bytes.slice().buffer);
                    this.mesh.applyData(ctx.getNumber(modelH), f32);
                }
                finally {
                    lifetime.dispose();
                }
            }
            catch (e) {
                // 非 ArrayBuffer / 已释放 / 未对齐 → 丢该帧，不抛进帧循环（但要可观测，否则静默失败）
                this.onWarn(`动态网格顶点上传失败：${e instanceof Error ? e.message : String(e)}`);
            }
        });
        define('layerVisible', (idH) => (this.mesh && this.mesh.isVisible(ctx.getNumber(idH)) ? ctx.true : ctx.false));
        define('setLayerVisible', (idH, vH) => { this.mesh?.setVisible(ctx.getNumber(idH), ctx.dump(vH) === true); });
        ctx.setProp(ctx.global, '__host', host);
        // engine.userProperties 直接内联进 prelude 源码（已过滤内嵌 base64 长值）。
        // 不用 parseJSON 之类的宿主 API：一个 eval 完成，也不额外产生句柄。
        // ⚠️ 用函数式 replace —— JSON 里的 `$&`/`$1` 在字符串式 replace 中会被当成替换模式。
        const propsJson = JSON.stringify(safeUserProperties(opts.userProperties));
        const pre = ctx.evalCode(PRELUDE.replace('userProperties: {}', () => `userProperties: ${propsJson}`), 'scene-script-prelude.js');
        if (pre.error) {
            pre.error.dispose();
            this.warn('SceneScript prelude 初始化失败');
            return false;
        }
        pre.value.dispose();
        return true;
    }
    /** prelude 的 key（`id:<scene对象id>` / `name:<名>` / `new:<名>`）→ scene 对象 id；非 id 形式返回 -1。 */
    keyOf(h) {
        const k = this.ctx.getString(h);
        const m = /^id:(\d+)$/.exec(k);
        return m ? Number(m[1]) : -1;
    }
    write(objectId, patch) {
        if (objectId < 0)
            return; // util/新建图层只记账不应用（哑句柄）
        if (Object.keys(patch).length === 0)
            return;
        this.state.write(objectId, patch);
    }
    anim(layerKey, name) {
        const key = `${layerKey}|${name}`;
        let a = this.animCache.get(key);
        if (!a) {
            a = this.anims.get(layerKey, name);
            this.animCache.set(key, a);
        }
        return a;
    }
    /** 装载一个模块脚本。返回 false = eval 失败（该脚本被跳过，其余继续）。
     *  `label` 用于日志（应带 scene 对象 id —— 脚本首行都是 `'use strict';`，不带 id 无法定位）。 */
    load(source, label) {
        const ctx = this.ctx;
        const sanitized = String(source ?? '').replace(/\bexport\s+/g, '');
        const tag = label ?? firstNonEmptyLine(sanitized);
        const code = `globalThis.__mods.push((function(){
${sanitized}
return {
  init: (typeof init === 'function') ? init : null,
  update: (typeof update === 'function') ? update : null,
  applyUserProperties: (typeof applyUserProperties === 'function') ? applyUserProperties : null,
  cursorClick: (typeof cursorClick === 'function') ? cursorClick : null
};
})());`;
        const r = ctx.evalCode(code, 'scene-script.js');
        if (r.error) {
            r.error.dispose();
            this.warn(`SceneScript eval 失败，已跳过该脚本（${tag}）`);
            return false;
        }
        r.value.dispose();
        const mods = ctx.getProp(ctx.global, '__mods');
        const lenH = ctx.getProp(mods, 'length');
        const len = ctx.getNumber(lenH);
        lenH.dispose();
        const inst = ctx.getProp(mods, len - 1);
        mods.dispose();
        const grab = (name) => {
            const h = ctx.getProp(inst, name);
            if (ctx.typeof(h) === 'function')
                return h;
            h.dispose();
            return null;
        };
        const m = {
            instance: inst,
            init: grab('init'),
            update: grab('update'),
            apply: grab('applyUserProperties'),
            click: grab('cursorClick'),
            active: true,
            label: tag,
        };
        this.handles.push(inst);
        for (const h of [m.init, m.update, m.apply, m.click])
            if (h)
                this.handles.push(h);
        this.modules.push(m);
        return true;
    }
    callOne(m, fn, mode) {
        if (!m.active || !fn)
            return undefined;
        this.budget = this.stepBudget; // 每个脚本每次调用一份新预算（见 create 的 handler 注释）
        const ctx = this.ctx;
        let argH;
        if (mode === 'props') {
            const engineH = ctx.getProp(ctx.global, 'engine');
            argH = ctx.getProp(engineH, 'userProperties');
            engineH.dispose();
        }
        else {
            argH = ctx.newString('');
        }
        const res = ctx.callFunction(fn, m.instance, argH);
        argH.dispose();
        if (res.error) {
            const msg = this.errorText(res.error);
            res.error.dispose();
            m.active = false;
            this.warn(`SceneScript 抛错，已停用该脚本（${m.label}）：${msg}`);
            return undefined;
        }
        const value = ctx.dump(res.value);
        res.value.dispose();
        return value;
    }
    /** 每帧时间（供 engine.frametime）。必须在 updateAll 之前设置。 */
    setFrametime(dt) {
        if (Number.isFinite(dt) && dt > 0)
            this.dt = dt;
    }
    /** 按装载顺序调 applyUserProperties（一次）与 init。 */
    initAll() {
        for (const m of this.modules) {
            this.callOne(m, m.apply, 'props');
            this.callOne(m, m.init, 'value');
        }
    }
    /**
     * 按装载顺序调 update（每帧），返回各自的返回值。
     *
     * ⚠️ 返回值是 `visible.script` 的**信号源** —— WE 语义里它就是「该对象本帧是否可见」。
     * 一期调用后把返回值丢弃了，于是 10 个歌曲字标全部显示（真机：两行歌名重影）。
     */
    updateAll() {
        const out = [];
        for (const m of this.modules)
            out.push(this.callOne(m, m.update, 'value'));
        return out;
    }
    /** 按装载顺序派发点击（cursorClick）。 */
    clickAll() {
        for (const m of this.modules)
            this.callOne(m, m.click, 'value');
    }
    get loadedCount() {
        return this.modules.length;
    }
    /** 仍可用的脚本数（抛错后被停用的不计）。 */
    get activeCount() {
        return this.modules.filter((m) => m.active).length;
    }
    dispose() {
        for (const h of this.handles) {
            try {
                h.dispose();
            }
            catch { /* 已释放 */ }
        }
        this.handles.length = 0;
        this.modules.length = 0;
        this.animCache.clear();
        try {
            this.ctx.dispose();
        }
        catch { /* noop */ }
        try {
            this.runtime.dispose();
        }
        catch { /* gc 断言可忽略 */ }
    }
    /** 错误文本：quickjs 的 TypeError 只给 "not a function" 这类无主语 message，必须带 stack 才能定位。 */
    errorText(errH) {
        const ctx = this.ctx;
        const grab = (prop) => {
            const h = ctx.getProp(errH, prop);
            const v = String(ctx.dump(h));
            h.dispose();
            return v;
        };
        try {
            const name = grab('name');
            const msg = grab('message');
            const stack = grab('stack').split('\n').slice(0, 4).map((l) => l.trim()).join(' ← ');
            return `${name}: ${msg}  @${stack}`;
        }
        catch {
            return '(unknown error)';
        }
    }
}
/** 过滤掉 project.json 属性里内嵌的 base64 长值 —— 注进 quickjs 会打爆解析栈（spike 实测）。 */
function safeUserProperties(props) {
    const out = {};
    for (const [k, v] of Object.entries(props ?? {})) {
        if (v === undefined)
            continue;
        if (typeof v === 'string' && v.length > 120)
            continue;
        out[k] = v;
    }
    return out;
}
function firstNonEmptyLine(s) {
    for (const l of s.split('\n')) {
        const t = l.trim();
        if (t)
            return t.slice(0, 60);
    }
    return '';
}
