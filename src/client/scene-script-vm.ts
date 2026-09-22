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
import type { QuickJSContext, QuickJSRuntime, QuickJSHandle, QuickJSWASMModule } from 'quickjs-emscripten';
import type { LayerStateTable, LayerWrite } from './layer-state.js';
import type { AnimPlayback, AnimRegistry } from './scene-anim.js';

export interface SceneScriptVmOptions {
  userProperties: Record<string, unknown>;
  state: LayerStateTable;
  anims: AnimRegistry;
  onWarn?: (msg: string) => void;
  /** 单次脚本调用的指令预算（缺省 50M）。测试可传小值，验证「预算每次调用都重置」。 */
  stepBudget?: number;
}

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

var thisScene = __wrap({
  getLayerByID: function (id) { return __mkLayer('id:' + id); },
  getLayer: function (n) { return __mkLayer('name:' + n); },
  createLayer: function (o) { return __mkLayer('new:' + ((o && o.name) ? o.name : 'anon')); },
  createModelData: function () { return __mkDummy('model'); }
}, 'thisScene');
var getLayerByID = thisScene.getLayerByID;
var getLayer = thisScene.getLayer;
var createLayer = thisScene.createLayer;

var engine = __wrap({
  userProperties: {},
  registerAsset: function () { return __mkDummy('asset'); },
  get frametime() { return __host.frametime(); }
}, 'engine');
var registerAsset = engine.registerAsset;

var shared = {};
var console = { log: __host.log, warn: __host.log, error: __host.log };
true;
`;

interface LoadedModule {
  instance: QuickJSHandle;
  init: QuickJSHandle | null;
  update: QuickJSHandle | null;
  apply: QuickJSHandle | null;
  click: QuickJSHandle | null;
  active: boolean;
  label: string;
}

export class SceneScriptVm {
  private readonly ctx: QuickJSContext;
  private readonly runtime: QuickJSRuntime;
  private readonly handles: QuickJSHandle[] = [];
  private readonly modules: LoadedModule[] = [];
  private readonly animCache = new Map<string, AnimPlayback>();
  private readonly state: LayerStateTable;
  private readonly anims: AnimRegistry;
  private readonly onWarn: (msg: string) => void;
  private dt = 1 / 60;
  /** 单次脚本调用的指令预算（缺省 STEP_BUDGET；callOne 每次调用前重置）。 */
  private readonly stepBudget: number;
  private budget: number;

  private constructor(ctx: QuickJSContext, runtime: QuickJSRuntime, opts: SceneScriptVmOptions) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.state = opts.state;
    this.anims = opts.anims;
    this.onWarn = opts.onWarn ?? ((): void => { /* 生产静默 */ });
    this.stepBudget = Number.isFinite(opts.stepBudget) && (opts.stepBudget as number) > 0
      ? (opts.stepBudget as number)
      : STEP_BUDGET;
    this.budget = this.stepBudget;
  }

  /** 初始化 quickjs 并装好 prelude。失败返回 null（调用方退回"无脚本"路径，画面等于现状）。 */
  static async create(opts: SceneScriptVmOptions): Promise<SceneScriptVm | null> {
    let runtime: QuickJSRuntime | null = null;
    try {
      // ⚠️ 浏览器必须显式给出 wasm 位置：库默认按 JS 自身 URL 推导，打包进 client.js 后会 404
      // （表现为 console 一串 "wasm streaming compile failed" 而脚本静默不执行 —— 只有 e2e 能发现）。
      // 与 text-script.ts 同源：host 把 quickjs.wasm 放在 /wallpapers/static/。
      const wasmLocation = typeof window !== 'undefined' ? '/wallpapers/static/quickjs.wasm' : undefined;
      const mod: QuickJSWASMModule = await newQuickJSWASMModuleFromVariant(
        newVariant(RELEASE_SYNC, wasmLocation ? { wasmLocation } : {}),
      );
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
    } catch {
      try { runtime?.dispose(); } catch { /* noop */ }
      return null;
    }
  }

  private keep<T extends QuickJSHandle>(h: T): T {
    this.handles.push(h);
    return h;
  }

  private warn(msg: string): void {
    this.onWarn(msg);
  }

  private installPrelude(opts: SceneScriptVmOptions): boolean {
    const ctx = this.ctx;
    const host = ctx.newObject();
    this.handles.push(host);

    const define = (name: string, impl: (...args: QuickJSHandle[]) => QuickJSHandle | void): void => {
      const fn = ctx.newFunction(name, (...args: QuickJSHandle[]) => impl(...args));
      ctx.setProp(host, name, fn);
      this.handles.push(fn);
    };

    // 读：未登记的图层给"不透明可见、缩放 1"的安全默认（脚本会读 baseAlpha/alpha 做判断）
    define('readNum', (k, p) => {
      const prop = ctx.getString(p);
      const w = this.state.read(this.keyOf(k));
      const v = (w as Record<string, unknown>)[prop];
      if (typeof v === 'number') return ctx.newNumber(v);
      return ctx.newNumber(prop === 'scale' ? 1 : prop === 'color' ? 1 : 1);
    });
    define('readBool', (k) => {
      const w = this.state.read(this.keyOf(k));
      return w.visible === false ? ctx.false : ctx.true;
    });
    define('readVec', (k, p) => {
      const prop = ctx.getString(p) as 'origin' | 'angles' | 'scale' | 'color';
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
      const patch: LayerWrite = prop === 'alpha' || prop === 'opacity' || prop === 'baseAlpha'
        ? { alpha: num }
        : {};
      this.write(this.keyOf(k), patch);
    });
    define('writeBool', (k, _p, v) => {
      this.write(this.keyOf(k), { visible: ctx.dump(v) === true });
    });
    define('writeVec', (k, p, x, y, z) => {
      const prop = ctx.getString(p) as 'origin' | 'angles' | 'scale' | 'color';
      const arr: [number, number, number] = [ctx.getNumber(x), ctx.getNumber(y), ctx.getNumber(z)];
      const patch: LayerWrite = prop === 'scale' ? { scale: arr }
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
    define('log', () => { /* 生产静默；需要时在这里转发到宿主 console */ });

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
  private keyOf(h: QuickJSHandle): number {
    const k = this.ctx.getString(h);
    const m = /^id:(\d+)$/.exec(k);
    return m ? Number(m[1]) : -1;
  }

  private write(objectId: number, patch: LayerWrite): void {
    if (objectId < 0) return; // util/新建图层只记账不应用（哑句柄）
    if (Object.keys(patch).length === 0) return;
    this.state.write(objectId, patch);
  }

  private anim(layerKey: string, name: string): AnimPlayback {
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
  load(source: string, label?: string): boolean {
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

    const grab = (name: string): QuickJSHandle | null => {
      const h = ctx.getProp(inst, name);
      if (ctx.typeof(h) === 'function') return h;
      h.dispose();
      return null;
    };
    const m: LoadedModule = {
      instance: inst,
      init: grab('init'),
      update: grab('update'),
      apply: grab('applyUserProperties'),
      click: grab('cursorClick'),
      active: true,
      label: tag,
    };
    this.handles.push(inst);
    for (const h of [m.init, m.update, m.apply, m.click]) if (h) this.handles.push(h);
    this.modules.push(m);
    return true;
  }

  private callOne(m: LoadedModule, fn: QuickJSHandle | null, mode: 'value' | 'props'): void {
    if (!m.active || !fn) return;
    this.budget = this.stepBudget; // 每个脚本每次调用一份新预算（见 create 的 handler 注释）
    const ctx = this.ctx;
    let argH: QuickJSHandle;
    if (mode === 'props') {
      const engineH = ctx.getProp(ctx.global, 'engine');
      argH = ctx.getProp(engineH, 'userProperties');
      engineH.dispose();
    } else {
      argH = ctx.newString('');
    }
    const res = ctx.callFunction(fn, m.instance, argH);
    argH.dispose();
    if (res.error) {
      const msg = this.errorText(res.error);
      res.error.dispose();
      m.active = false;
      this.warn(`SceneScript 抛错，已停用该脚本（${m.label}）：${msg}`);
      return;
    }
    res.value.dispose();
  }

  /** 每帧时间（供 engine.frametime）。必须在 updateAll 之前设置。 */
  setFrametime(dt: number): void {
    if (Number.isFinite(dt) && dt > 0) this.dt = dt;
  }

  /** 按装载顺序调 applyUserProperties（一次）与 init。 */
  initAll(): void {
    for (const m of this.modules) {
      this.callOne(m, m.apply, 'props');
      this.callOne(m, m.init, 'value');
    }
  }

  /** 按装载顺序调 update（每帧）。 */
  updateAll(): void {
    for (const m of this.modules) this.callOne(m, m.update, 'value');
  }

  /** 按装载顺序派发点击（cursorClick）。 */
  clickAll(): void {
    for (const m of this.modules) this.callOne(m, m.click, 'value');
  }

  get loadedCount(): number {
    return this.modules.length;
  }

  /** 仍可用的脚本数（抛错后被停用的不计）。 */
  get activeCount(): number {
    return this.modules.filter((m) => m.active).length;
  }

  dispose(): void {
    for (const h of this.handles) {
      try { h.dispose(); } catch { /* 已释放 */ }
    }
    this.handles.length = 0;
    this.modules.length = 0;
    this.animCache.clear();
    try { this.ctx.dispose(); } catch { /* noop */ }
    try { this.runtime.dispose(); } catch { /* gc 断言可忽略 */ }
  }

  /** 错误文本：quickjs 的 TypeError 只给 "not a function" 这类无主语 message，必须带 stack 才能定位。 */
  private errorText(errH: QuickJSHandle): string {
    const ctx = this.ctx;
    const grab = (prop: string): string => {
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
    } catch {
      return '(unknown error)';
    }
  }
}

/** 过滤掉 project.json 属性里内嵌的 base64 长值 —— 注进 quickjs 会打爆解析栈（spike 实测）。 */
function safeUserProperties(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined) continue;
    if (typeof v === 'string' && v.length > 120) continue;
    out[k] = v;
  }
  return out;
}

function firstNonEmptyLine(s: string): string {
  for (const l of s.split('\n')) {
    const t = l.trim();
    if (t) return t.slice(0, 60);
  }
  return '';
}
