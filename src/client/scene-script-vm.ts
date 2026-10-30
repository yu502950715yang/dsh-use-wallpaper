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
import type { TimelineAnimationSource } from './scene-timeline.js';
import type { DynamicMeshRegistry } from './dynamic-mesh.js';
import type { MediaPropertiesPayload } from '../shared/media.js';
import type { ObjectScriptProperty, TimelineProperty } from '../shared/types.js';

export interface TextureAnimationHost {
  pause(objectId: number): void;
  play(objectId: number): void;
  stop(objectId: number): void;
  isPlaying(objectId: number): boolean;
  setFrame(objectId: number, frame: number): void;
  getFrame(objectId: number): number;
}

/** WE SceneScript localStorage 的底层字符串存储（前缀/序列化由本模块负责）。 */
export interface SceneScriptStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 场景脚本 localStorage 的键前缀（与插件其他 we:* 键隔离）。 */
export const SCENE_SCRIPT_STORAGE_PREFIX = 'we:scenescript:';

/** 媒体事件名（与 WE SceneScript 的四个全局 handler 同名）。 */
export type MediaDispatchEvent =
  | 'mediaPlaybackChanged'
  | 'mediaStatusChanged'
  | 'mediaPropertiesChanged'
  | 'mediaThumbnailChanged';

/** mediaThumbnailChanged 的封面色（5 个 0-1 RGB 三元组）。 */
export interface MediaThumbnailPayload {
  hasThumbnail: boolean;
  primaryColor: [number, number, number];
  secondaryColor: [number, number, number];
  tertiaryColor: [number, number, number];
  textColor: [number, number, number];
  highContrastColor: [number, number, number];
}

/** 一次媒体派发（字段按 event 取用）。playback 用 MediaPlaybackEvent 常量：0/1/2。 */
export interface MediaDispatch {
  event: MediaDispatchEvent;
  playback?: number;
  enabled?: boolean;
  properties?: MediaPropertiesPayload;
  thumbnail?: MediaThumbnailPayload;
}

/** 一次脚本调用的返回值与归属（host 据此只对无 property 的布尔写 visible）。 */
export interface ScriptUpdateResult {
  objectId: number | null;
  property: ObjectScriptProperty | null;
  value: unknown;
}

export interface SceneScriptVmOptions {
  userProperties: Record<string, unknown>;
  state: LayerStateTable;
  anims: AnimRegistry;
  onWarn?: (msg: string) => void;
  /** 单次脚本调用的指令预算（缺省 50M）。测试可传小值，验证「预算每次调用都重置」。 */
  stepBudget?: number;
  /** 动态网格注册表；缺省时 createModelData/createLayer 仍是安全的哑对象（其他壁纸零影响）。 */
  dynamicMesh?: DynamicMeshRegistry;
  /** engine.registerAsset 的回调：装载期按此收集材质资产路径。 */
  onAsset?: (materialPath: string) => void;
  /** 对象级脚本的纹理动画（thisLayer.getTextureAnimation）；缺省 = 安全 no-op。 */
  textureAnimation?: TextureAnimationHost;
  /** engine.timeOfDay 的 0-1 时间源（缺省本地时钟；测试注入固定值）。 */
  timeOfDay?: () => number;
  /** localStorage 底层存储（缺省浏览器 localStorage，node/隐私模式退回内存）。 */
  storage?: SceneScriptStorage;
  /** 壁纸 id：脚本 localStorage 按壁纸隔离（`we:scenescript:<wallpaperId>:<key>`）；缺省不加段。 */
  wallpaperId?: string;
  /** 时间线动画源（thisObject.getAnimation 优先查它；缺省回退 AnimRegistry）。 */
  timeline?: TimelineAnimationSource;
}

// 单脚本一次调用的指令预算：正常脚本远低于此；死循环在此被中断。
const STEP_BUDGET = 50_000_000;
// 媒体回调置 alpha≈0 的判定阈值（与 layer-state 的可见性阈值同口径）。
const HIDDEN_ALPHA = 0.002;

// prelude：在 quickjs 全局作用域定义宿主 API 与 WE 内置类型。所有状态都在宿主的 state/anims。
// `engine.frametime` 用 getter 走宿主原语 —— 避免每帧新建 number 句柄。
const PRELUDE = `
var __mods = [];

function Vec2(x, y) { this.x = x || 0; this.y = y || 0; }
function Vec3(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; }
function Vec4(x, y, z, w) { this.x = x || 0; this.y = y || 0; this.z = z || 0; this.w = w || 0; }
// WE 脚本常用 copy()（2937346640 的 Simple Visualizer 在 update 里 baseOrigin.copy()）。
Vec2.prototype.copy = function () { return new Vec2(this.x, this.y); };
Vec3.prototype.copy = function () { return new Vec3(this.x, this.y, this.z); };
Vec4.prototype.copy = function () { return new Vec4(this.x, this.y, this.z, this.w); };
var IModelData = { POSITION: 0, UV: 1, COLOR: 2, NORMAL: 3, TANGENT: 4 };

function __noop() {}

// WE 的 scriptProperties builder（对象级脚本顶层就会调用，如 3765967112 的 addSlider）。
// finish() = {...builder 默认值, ...scene.json 覆盖值}；add* 一律兜底（名字长尾见 text-script）。
function createScriptProperties() {
  var injected = (typeof __weScriptProps === 'object' && __weScriptProps) ? __weScriptProps : {};
  var defaults = {};
  var proxy = null;
  function add(o) { if (o && o.name) defaults[o.name] = o.value; return proxy; }
  var api = { finish: function () { return Object.assign({}, defaults, injected); } };
  proxy = new Proxy(api, {
    get: function (t, k) {
      if (k in t) return t[k];
      if (typeof k === 'string' && k.indexOf('add') === 0) return add;
      return undefined;
    }
  });
  return proxy;
}

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

// 媒体事件类常量（WE 官方数值：STOPPED=0 / PLAYING=1 / PAUSED=2）。
var MediaPlaybackEvent = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };

// 属性/命名时间线动画播放器：与 __mkAnim 不同，走时间线源（宿主解析，缺省回退 AnimRegistry）。
var __propAnimCache = {};
function __mkPropAnim(key, property, name) {
  var k = key + '|' + property + '|' + name;
  if (__propAnimCache[k]) return __propAnimCache[k];
  __propAnimCache[k] = {
    play: function () { __host.propAnimPlay(key, property, name); },
    pause: function () { __host.propAnimPause(key, property, name); },
    stop: function () { __host.propAnimStop(key, property, name); },
    isPlaying: function () { return __host.propAnimIsPlaying(key, property, name); },
    setFrame: function (f) { __host.propAnimSetFrame(key, property, name, f); },
    getFrame: function () { return __host.propAnimGetFrame(key, property, name); },
    get rank() { return 0; },
    get rate() { return __host.propAnimRate(key, property, name); },
    set rate(v) { __host.propAnimSetRate(key, property, name, v); }
  };
  return __propAnimCache[k];
}
// thisObject：当前脚本所属对象（属性脚本带当前属性；visible/text 脚本 property 为空串）。
var __thisObjectCache = {};
function __mkThisObject(key, property) {
  var ck = key + '|' + property;
  if (__thisObjectCache[ck]) return __thisObjectCache[ck];
  var layer = __mkLayer(key);
  __thisObjectCache[ck] = new Proxy(layer, {
    get: function (t, prop) {
      if (prop === 'getAnimation') {
        return function (name) { return __mkPropAnim(key, property, name ? String(name) : ''); };
      }
      return t[prop];
    }
  });
  return __thisObjectCache[ck];
}
Object.defineProperty(globalThis, 'thisObject', {
  get: function () { return __mkThisObject(__host.currentLayerKey(), __host.currentProperty()); },
  configurable: true
});

var __texAnimCache = {};
function __mkTextureAnimation(key) {
  if (__texAnimCache[key]) return __texAnimCache[key];
  // 未知成员（setSpeed 等）走 __wrap → __any，避免单个缺失方法 TypeError 停用脚本。
  __texAnimCache[key] = __wrap({
    pause: function () { __host.texAnimPause(key); },
    play: function () { __host.texAnimPlay(key); },
    stop: function () { __host.texAnimStop(key); },
    isPlaying: function () { return __host.texAnimIsPlaying(key); },
    setFrame: function (frame) { __host.texAnimSetFrame(key, frame); },
    getFrame: function () { return __host.texAnimGetFrame(key); }
  }, 'texanim(' + key + ')');
  return __texAnimCache[key];
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
    getTextureAnimation: function () { return __mkTextureAnimation(key); },
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
  get frametime() { return __host.frametime(); },
  get timeOfDay() { return __host.timeOfDay(); }
}, 'engine');
var registerAsset = engine.registerAsset;

// 当前脚本所属图层（宿主在每次调用前设置当前对象 key）；与 thisScene.getLayerByID 同一句柄缓存。
Object.defineProperty(globalThis, 'thisLayer', {
  get: function () { return __mkLayer(__host.currentLayerKey()); },
  configurable: true
});

var shared = {};

// WE SceneScript 的 localStorage（每键 JSON 序列化；宿主负责前缀与持久化）。
var localStorage = __wrap({
  get: function (k) {
    var raw = __host.lsGet(String(k));
    if (raw === null || raw === undefined) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  },
  set: function (k, v) {
    var raw;
    try { raw = JSON.stringify(v); } catch (e) { return; }
    if (raw !== undefined) __host.lsSet(String(k), raw);
  }
}, 'localStorage');

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
  /** 本模块所属对象的图层 key（`id:<id>`；无 objectId 时为空串）。 */
  layerKey: string;
  /** 该脚本挂载的转换属性（angles 等）；null = 生命周期/visible.script 脚本。 */
  property: ObjectScriptProperty | null;
  /** 本模块所属 scene 对象 id（属性写回用；无 objectId 时 null）。 */
  objectId: number | null;
  /** 四个媒体事件 handler（脚本未导出时 null）。 */
  media: {
    playback: QuickJSHandle | null;
    status: QuickJSHandle | null;
    properties: QuickJSHandle | null;
    thumbnail: QuickJSHandle | null;
  };
}

export class SceneScriptVm {
  private readonly ctx: QuickJSContext;
  private readonly runtime: QuickJSRuntime;
  private readonly handles: QuickJSHandle[] = [];
  private readonly modules: LoadedModule[] = [];
  private readonly animCache = new Map<string, AnimPlayback>();
  private readonly propAnimCache = new Map<string, AnimPlayback>();
  private readonly state: LayerStateTable;
  private readonly anims: AnimRegistry;
  /** 时间线动画源（thisObject.getAnimation 优先查它；null = 只走 AnimRegistry）。 */
  private readonly timeline: TimelineAnimationSource | null;
  private readonly onWarn: (msg: string) => void;
  /** 动态网格注册表（createModelData/createLayer/applyData 的真实落点）；缺省 = stub 行为。 */
  private readonly mesh: DynamicMeshRegistry | null;
  /** engine.registerAsset 的回调（装载期用它解析材质资产路径）。 */
  private readonly onAsset: ((materialPath: string) => void) | null;
  /** 纹理动画宿主（对象级脚本的 thisLayer.getTextureAnimation）；null = 安全 no-op。 */
  private readonly texAnim: TextureAnimationHost | null;
  /** engine.timeOfDay 时间源。 */
  private readonly timeOfDay: () => number;
  /** localStorage 底层字符串存储。 */
  private readonly storage: SceneScriptStorage;
  /** 壁纸 id（localStorage 键的隔离段；空串 = 兼容旧前缀）。 */
  private readonly wallpaperId: string;
  /** 当前正在执行的脚本所属图层 key（`id:<对象 id>`；thisLayer 的解析依据）。 */
  private currentKey = '';
  /** 当前脚本挂载的属性（thisObject.getAnimation 的绑定属性；生命周期脚本为空串）。 */
  private currentProperty = '';
  private dt = 1 / 60;
  /** 单次脚本调用的指令预算（缺省 STEP_BUDGET；callOne 每次调用前重置）。 */
  private readonly stepBudget: number;
  private budget: number;

  private constructor(ctx: QuickJSContext, runtime: QuickJSRuntime, opts: SceneScriptVmOptions) {
    this.ctx = ctx;
    this.runtime = runtime;
    this.state = opts.state;
    this.anims = opts.anims;
    this.timeline = opts.timeline ?? null;
    this.onWarn = opts.onWarn ?? ((): void => { /* 生产静默 */ });
    this.mesh = opts.dynamicMesh ?? null;
    this.onAsset = opts.onAsset ?? null;
    this.texAnim = opts.textureAnimation ?? null;
    this.timeOfDay = opts.timeOfDay ?? localTimeOfDay;
    this.storage = opts.storage ?? createDefaultStorage();
    this.wallpaperId = typeof opts.wallpaperId === 'string' ? opts.wallpaperId : '';
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
    // thisObject.getAnimation(name) 的宿主桥：时间线源优先，未命中回退 AnimRegistry（结果缓存）。
    const propPlayback = (k: QuickJSHandle, p: QuickJSHandle, n: QuickJSHandle): AnimPlayback =>
      this.propAnim(ctx.getString(k), ctx.getString(p), ctx.getString(n));
    define('propAnimPlay', (k, p, n) => { propPlayback(k, p, n).play(); });
    define('propAnimPause', (k, p, n) => { propPlayback(k, p, n).pause(); });
    define('propAnimStop', (k, p, n) => { propPlayback(k, p, n).stop(); });
    define('propAnimIsPlaying', (k, p, n) => (propPlayback(k, p, n).isPlaying() ? ctx.true : ctx.false));
    define('propAnimSetFrame', (k, p, n, f) => { propPlayback(k, p, n).setFrame(ctx.getNumber(f)); });
    define('propAnimGetFrame', (k, p, n) => ctx.newNumber(propPlayback(k, p, n).getFrame()));
    define('propAnimRate', (k, p, n) => ctx.newNumber(propPlayback(k, p, n).rate ?? 1));
    define('propAnimSetRate', (k, p, n, r) => {
      if (ctx.typeof(r) !== 'number') return;
      propPlayback(k, p, n).rate = ctx.getNumber(r);
    });
    define('frametime', () => ctx.newNumber(this.dt));
    define('log', () => { /* 生产静默；需要时在这里转发到宿主 console */ });

    // ── 对象级脚本原语（2026-10-20）：thisLayer / engine.timeOfDay / localStorage ──
    define('currentLayerKey', () => ctx.newString(this.currentKey));
    define('currentProperty', () => ctx.newString(this.currentProperty));
    define('texAnimPause', (k) => { this.texAnim?.pause(this.keyOf(k)); });
    define('texAnimPlay', (k) => { this.texAnim?.play(this.keyOf(k)); });
    define('texAnimStop', (k) => { this.texAnim?.stop(this.keyOf(k)); });
    define('texAnimIsPlaying', (k) => {
      const id = this.keyOf(k);
      return this.texAnim && id >= 0 && this.texAnim.isPlaying(id) ? ctx.true : ctx.false;
    });
    define('texAnimSetFrame', (k, f) => {
      const id = this.keyOf(k);
      if (this.texAnim && id >= 0) this.texAnim.setFrame(id, ctx.getNumber(f));
    });
    define('texAnimGetFrame', (k) => {
      const id = this.keyOf(k);
      return ctx.newNumber(this.texAnim && id >= 0 ? this.texAnim.getFrame(id) : -1);
    });
    // engine.timeOfDay：0-1 的本地时间（宿主可注入固定值；越界/非有限值钳到 [0,1)）。
    define('timeOfDay', () => {
      let v = 0;
      try { v = this.timeOfDay(); } catch { v = 0; }
      if (!Number.isFinite(v)) v = 0;
      // 1 与 0 同义（次日午夜）：钳到 [0,1) 与注释/单测口径一致。
      if (v <= 0) v = 0;
      else if (v >= 1) v = 0.9999999999999999;
      return ctx.newNumber(v);
    });
    define('lsGet', (k) => {
      let raw: string | null = null;
      try { raw = this.storage.getItem(this.storageKey(ctx.getString(k))); } catch { raw = null; }
      return raw === null || raw === undefined ? ctx.null : ctx.newString(raw);
    });
    define('lsSet', (k, v) => {
      try {
        this.storage.setItem(this.storageKey(ctx.getString(k)), ctx.getString(v));
      } catch { /* 配额/隐私模式：脚本侧静默失败（与浏览器 localStorage 语义一致） */ }
    });

    // ── 动态网格原语（2026-09-22）：createModelData / createLayer / applyData 的真实落点。
    //    未注入 registry 时全部退化为安全空操作（其他壁纸零影响）。──
    define('registerAsset', (pH) => { this.onAsset?.(ctx.getString(pH)); });
    define('createModel', (specH) => {
      if (!this.mesh) return ctx.newNumber(-1);
      const spec = ctx.dump(specH) as { capacity?: unknown; vertexFormat?: unknown; materialPath?: unknown } | null;
      const id = this.mesh.createModel({
        capacity: Number(spec?.capacity ?? 0),
        vertexFormat: Array.isArray(spec?.vertexFormat) ? (spec.vertexFormat as number[]) : [],
        materialPath: typeof spec?.materialPath === 'string' ? spec.materialPath : null,
      });
      return ctx.newNumber(id === null ? -1 : id);
    });
    define('createLayer', (modelH, nameH) => {
      if (!this.mesh) return ctx.newNumber(-1);
      return ctx.newNumber(this.mesh.createLayer(ctx.getNumber(modelH), ctx.getString(nameH)));
    });
    // 顶点上传：quickjs 的 ArrayBuffer → 宿主 Float32Array 视图。
    // ⚠️ getArrayBuffer 返回的是 `_Lifetime{ value: Uint8Array }`（wasm 内存视图，byteOffset 非 0），
    // 不是 Uint8Array 本身 —— 必须经 `.value` 取，并用 (buffer, byteOffset, len) 建视图。
    define('applyMeshData', (modelH, bufH) => {
      if (!this.mesh) return;
      try {
        const lifetime = ctx.getArrayBuffer(bufH);
        try {
          const bytes = lifetime.value;
          const f32 = bytes.byteOffset % 4 === 0
            ? new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 2)
            : new Float32Array(bytes.slice().buffer);
          this.mesh.applyData(ctx.getNumber(modelH), f32);
        } finally {
          lifetime.dispose();
        }
      } catch (e) {
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

  /** localStorage 键：按壁纸隔离（`we:scenescript:<wallpaperId>:<key>`）；无 id 时保持旧前缀。 */
  private storageKey(key: string): string {
    return this.wallpaperId
      ? `${SCENE_SCRIPT_STORAGE_PREFIX}${this.wallpaperId}:${key}`
      : SCENE_SCRIPT_STORAGE_PREFIX + key;
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
   *  `label` 用于日志（应带 scene 对象 id —— 脚本首行都是 `'use strict';`，不带 id 无法定位）。
   *  `objectId` 供 thisLayer 解析；`scriptProperties` 是 scene.json 的覆盖值（注入给 createScriptProperties）；
   *  `property` 非空 = WE 属性脚本（angles/origin/scale/color）：update(value) 收/回 Vec3。 */
  load(
    source: string,
    label?: string,
    objectId?: number,
    scriptProperties?: Record<string, unknown>,
    property?: ObjectScriptProperty,
  ): boolean {
    const ctx = this.ctx;
    const sanitized = String(source ?? '').replace(/\bexport\s+/g, '');
    const tag = label ?? firstNonEmptyLine(sanitized);
    const code = `globalThis.__mods.push((function(){
${sanitized}
return {
  init: (typeof init === 'function') ? init : null,
  update: (typeof update === 'function') ? update : null,
  applyUserProperties: (typeof applyUserProperties === 'function') ? applyUserProperties : null,
  cursorClick: (typeof cursorClick === 'function') ? cursorClick : null,
  mediaPlaybackChanged: (typeof mediaPlaybackChanged === 'function') ? mediaPlaybackChanged : null,
  mediaStatusChanged: (typeof mediaStatusChanged === 'function') ? mediaStatusChanged : null,
  mediaPropertiesChanged: (typeof mediaPropertiesChanged === 'function') ? mediaPropertiesChanged : null,
  mediaThumbnailChanged: (typeof mediaThumbnailChanged === 'function') ? mediaThumbnailChanged : null
};
})());`;
    this.currentKey = objectId === undefined ? '' : `id:${objectId}`;
    this.currentProperty = property ?? '';
    // scene.json 的 scriptproperties → 全局 __weScriptProps（createScriptProperties().finish() 合并）。
    // 每个模块 eval 前设置、eval 后清除：属性值属于各自脚本，不能泄漏给下一个模块。
    const propsH = ctx.newObject();
    for (const [key, value] of Object.entries(scriptProperties ?? {})) {
      if (typeof value === 'boolean') ctx.setProp(propsH, key, value ? ctx.true : ctx.false);
      else if (typeof value === 'number' && Number.isFinite(value)) {
        const h = ctx.newNumber(value);
        ctx.setProp(propsH, key, h);
        h.dispose();
      } else if (typeof value === 'string') {
        const h = ctx.newString(value);
        ctx.setProp(propsH, key, h);
        h.dispose();
      }
    }
    ctx.setProp(ctx.global, '__weScriptProps', propsH);
    const r = ctx.evalCode(code, 'scene-script.js');
    ctx.setProp(ctx.global, '__weScriptProps', ctx.undefined);
    propsH.dispose();
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
      media: {
        playback: grab('mediaPlaybackChanged'),
        status: grab('mediaStatusChanged'),
        properties: grab('mediaPropertiesChanged'),
        thumbnail: grab('mediaThumbnailChanged'),
      },
      active: true,
      label: tag,
      layerKey: objectId === undefined ? '' : `id:${objectId}`,
      property: objectId === undefined ? null : (property ?? null),
      objectId: objectId === undefined ? null : objectId,
    };
    this.handles.push(inst);
    for (const h of [m.init, m.update, m.apply, m.click]) if (h) this.handles.push(h);
    for (const h of [m.media.playback, m.media.status, m.media.properties, m.media.thumbnail]) {
      if (h) this.handles.push(h);
    }
    this.modules.push(m);
    return true;
  }

  private callOne(m: LoadedModule, fn: QuickJSHandle | null, mode: 'value' | 'props'): unknown {
    if (!m.active || !fn) return undefined;
    this.currentKey = m.layerKey; // thisLayer 解析依据：每次调用前指向当前脚本所属对象
    this.currentProperty = m.property ?? '';
    this.budget = this.stepBudget; // 每个脚本每次调用一份新预算（见 create 的 handler 注释）
    const ctx = this.ctx;
    const isPropertyValue = mode === 'value' && m.property !== null;
    let argH: QuickJSHandle;
    if (mode === 'props') {
      const engineH = ctx.getProp(ctx.global, 'engine');
      argH = ctx.getProp(engineH, 'userProperties');
      engineH.dispose();
    } else if (isPropertyValue) {
      // WE 属性脚本契约：update(value)/init(value) 收**当前值**的 Vec3（脚本原地改或返回新值）。
      argH = this.vecHandle(m.property!, m.objectId!);
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
      return undefined;
    }
    const value = ctx.dump(res.value);
    res.value.dispose();
    if (isPropertyValue) {
      // 返回 Vec3-like 才写回属性；无返回/非向量 → 不动属性。属性返回值**不是** visible 信号。
      const vec = vecLike(value);
      if (vec) this.write(m.objectId!, { [m.property!]: vec } as LayerWrite);
      return undefined;
    }
    return value;
  }

  /** 当前属性值的 quickjs Vec3 句柄（属性脚本入参；缺省值与 readVec 同口径）。 */
  private vecHandle(property: ObjectScriptProperty, objectId: number): QuickJSHandle {
    const ctx = this.ctx;
    const cur = this.state.read(objectId)[property];
    const dflt: [number, number, number] = property === 'scale' || property === 'color' ? [1, 1, 1] : [0, 0, 0];
    const arr = cur ?? dflt;
    const obj = ctx.newObject();
    for (const [i, axis] of (['x', 'y', 'z'] as const).entries()) {
      const n = ctx.newNumber(arr[i] ?? dflt[i]);
      ctx.setProp(obj, axis, n);
      n.dispose();
    }
    return obj;
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

  /**
   * 按装载顺序调 update（每帧）；每个 module 一条，带 objectId/property 供 host 分类处理。
   *
   * ⚠️ 无 property 的脚本返回值是 `visible.script` 的**信号源** —— WE 语义里它就是「该对象本帧
   * 是否可见」。属性脚本（angles/origin/scale/color）的返回值已写回属性，这里一律 undefined（不混用）。
   */
  updateAll(): ScriptUpdateResult[] {
    const out: ScriptUpdateResult[] = [];
    for (const m of this.modules) {
      out.push({ objectId: m.objectId, property: m.property, value: this.callOne(m, m.update, 'value') });
    }
    return out;
  }

  /** 派发一次媒体事件到各脚本的同名 handler；返回实际调用成功的数量。 */
  dispatchMedia(dispatch: MediaDispatch): number {
    const ctx = this.ctx;
    let called = 0;
    for (const m of this.modules) {
      const fn = dispatch.event === 'mediaPlaybackChanged' ? m.media.playback
        : dispatch.event === 'mediaStatusChanged' ? m.media.status
          : dispatch.event === 'mediaPropertiesChanged' ? m.media.properties
            : m.media.thumbnail;
      if (!m.active || !fn) continue;
      // 属性脚本的 media 回调常先写 alpha=0 再播放淡入动画（真实素材同一段 fade 脚本挂在
      // alpha/origin/scale 多个属性上）。无时间线时动画不会跑 ⇒ 只回滚这次 alpha≈0 写入，
      // 其余属性（color/scale/origin）照常生效 —— 不能整类跳过（Task 8 主色边框依赖 color 回调）。
      // Task 10 传入 timeline 后回滚自然解除；届时必须补「淡入」e2e 判据。
      const alphaBefore = !this.timeline && m.property !== null && m.objectId !== null
        ? this.state.read(m.objectId).alpha
        : undefined;
      this.currentKey = m.layerKey;
      this.currentProperty = m.property ?? '';
      this.budget = this.stepBudget;
      const ev = this.buildMediaEvent(dispatch);
      try {
        const res = ctx.callFunction(fn, m.instance, ev);
        if (res.error) {
          const msg = this.errorText(res.error);
          res.error.dispose();
          m.active = false;
          this.warn(`SceneScript 抛错，已停用该脚本（${m.label}）：${msg}`);
          continue;
        }
        res.value.dispose();
        called += 1;
      } catch (e) {
        // 宿主侧异常（如句柄已失）同样只停用该脚本，绝不抛进帧循环。
        m.active = false;
        this.warn(`SceneScript 媒体事件调用失败（${m.label}）：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        ev.dispose();
        if (!this.timeline && m.property !== null && m.objectId !== null) {
          this.restoreMediaAlpha(m.objectId, alphaBefore);
        }
      }
    }
    return called;
  }

  /** 无时间线时回滚媒体回调写入的 alpha≈0（动画不跑会永久透明）；有 timeline 时留给动画淡回 1。 */
  private restoreMediaAlpha(objectId: number, before: number | undefined): void {
    const after = this.state.read(objectId).alpha;
    if (after === undefined || after > HIDDEN_ALPHA || after === before) return;
    this.state.write(objectId, { alpha: before });
  }

  /** 构造本次媒体事件对象（颜色按 Vec3 形态 {x,y,z}；每次派发新建，调用方负责 dispose）。 */
  private buildMediaEvent(d: MediaDispatch): QuickJSHandle {
    const ctx = this.ctx;
    const obj = ctx.newObject();
    const str = (k: string, v: string): void => {
      const h = ctx.newString(v);
      ctx.setProp(obj, k, h);
      h.dispose();
    };
    const num = (k: string, v: number): void => {
      const h = ctx.newNumber(v);
      ctx.setProp(obj, k, h);
      h.dispose();
    };
    const bool = (k: string, v: boolean): void => ctx.setProp(obj, k, v ? ctx.true : ctx.false);
    const vec = (k: string, v: [number, number, number]): void => {
      const o = ctx.newObject();
      for (const [axis, n] of [['x', v[0]], ['y', v[1]], ['z', v[2]]] as const) {
        const h = ctx.newNumber(n);
        ctx.setProp(o, axis, h);
        h.dispose();
      }
      ctx.setProp(obj, k, o);
      o.dispose();
    };
    if (d.event === 'mediaPlaybackChanged') num('state', d.playback ?? 0);
    else if (d.event === 'mediaStatusChanged') bool('enabled', !!d.enabled);
    else if (d.event === 'mediaPropertiesChanged') {
      const p = d.properties ?? { title: '', artist: '', album: '', contentType: '' };
      str('title', p.title);
      str('artist', p.artist);
      str('album', p.album);
      str('contentType', p.contentType);
      // WE 脚本兼容字段（长尾脚本可能读这些）。
      str('albumTitle', p.album);
      str('subTitle', '');
      str('albumArtist', p.artist);
      str('genres', '');
    } else {
      const t = d.thumbnail ?? {
        hasThumbnail: false,
        primaryColor: [0, 0, 0] as [number, number, number],
        secondaryColor: [0, 0, 0] as [number, number, number],
        tertiaryColor: [0, 0, 0] as [number, number, number],
        textColor: [0, 0, 0] as [number, number, number],
        highContrastColor: [0, 0, 0] as [number, number, number],
      };
      bool('hasThumbnail', t.hasThumbnail);
      vec('primaryColor', t.primaryColor);
      vec('secondaryColor', t.secondaryColor);
      vec('tertiaryColor', t.tertiaryColor);
      vec('textColor', t.textColor);
      vec('highContrastColor', t.highContrastColor);
    }
    return obj;
  }

  /** thisObject.getAnimation 的播放器解析：时间线 getByProperty → getByName → AnimRegistry。 */
  private propAnim(layerKey: string, property: string, name: string): AnimPlayback {
    const key = `${layerKey}|${property}|${name}`;
    const hit = this.propAnimCache.get(key);
    if (hit) return hit;
    const m = /^id:(\d+)$/.exec(layerKey);
    const objectId = m ? Number(m[1]) : -1;
    const tl = objectId >= 0 ? this.timeline : null;
    const pb = (tl && property ? tl.getByProperty(objectId, property as TimelineProperty, name) : null)
      ?? (tl && name ? tl.getByName(objectId, name) : null)
      ?? this.anims.get(layerKey, name || property);
    this.propAnimCache.set(key, pb);
    return pb;
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
    this.propAnimCache.clear();
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

/** 把脚本返回值收窄成 Vec3（有有限数值 x/y/z 才算；其余返回 null = 不动属性）。 */
function vecLike(v: unknown): [number, number, number] | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { x?: unknown; y?: unknown; z?: unknown };
  if (typeof o.x !== 'number' || !Number.isFinite(o.x)) return null;
  if (typeof o.y !== 'number' || !Number.isFinite(o.y)) return null;
  if (typeof o.z !== 'number' || !Number.isFinite(o.z)) return null;
  return [o.x, o.y, o.z];
}

/** engine.timeOfDay 缺省值：本地时钟的当天占比（0 = 午夜，0.5 = 正午）。 */
export function localTimeOfDay(): number {
  const d = new Date();
  const seconds = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() + d.getMilliseconds() / 1000;
  return seconds / 86400;
}

/** localStorage 底层存储：浏览器用真实 Web Storage（隐私模式抛错 → 内存），node 测试用内存。 */
function createDefaultStorage(): SceneScriptStorage {
  try {
    const ls = (globalThis as { localStorage?: SceneScriptStorage }).localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') return ls;
  } catch { /* SecurityError（禁用存储）→ 内存 */ }
  const mem = new Map<string, string>();
  return {
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => { mem.set(k, v); },
  };
}
