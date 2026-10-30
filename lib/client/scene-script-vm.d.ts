import type { LayerStateTable } from './layer-state.js';
import type { AnimRegistry } from './scene-anim.js';
import type { TimelineAnimationSource } from './scene-timeline.js';
import type { DynamicMeshRegistry } from './dynamic-mesh.js';
import type { MediaPropertiesPayload } from '../shared/media.js';
import type { ObjectScriptProperty } from '../shared/types.js';
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
export declare const SCENE_SCRIPT_STORAGE_PREFIX = "we:scenescript:";
/** 媒体事件名（与 WE SceneScript 的四个全局 handler 同名）。 */
export type MediaDispatchEvent = 'mediaPlaybackChanged' | 'mediaStatusChanged' | 'mediaPropertiesChanged' | 'mediaThumbnailChanged';
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
export declare class SceneScriptVm {
    private readonly ctx;
    private readonly runtime;
    private readonly handles;
    private readonly modules;
    private readonly animCache;
    private readonly propAnimCache;
    private readonly state;
    private readonly anims;
    /** 时间线动画源（thisObject.getAnimation 优先查它；null = 只走 AnimRegistry）。 */
    private readonly timeline;
    private readonly onWarn;
    /** 动态网格注册表（createModelData/createLayer/applyData 的真实落点）；缺省 = stub 行为。 */
    private readonly mesh;
    /** engine.registerAsset 的回调（装载期用它解析材质资产路径）。 */
    private readonly onAsset;
    /** 纹理动画宿主（对象级脚本的 thisLayer.getTextureAnimation）；null = 安全 no-op。 */
    private readonly texAnim;
    /** engine.timeOfDay 时间源。 */
    private readonly timeOfDay;
    /** localStorage 底层字符串存储。 */
    private readonly storage;
    /** 壁纸 id（localStorage 键的隔离段；空串 = 兼容旧前缀）。 */
    private readonly wallpaperId;
    /** 当前正在执行的脚本所属图层 key（`id:<对象 id>`；thisLayer 的解析依据）。 */
    private currentKey;
    /** 当前脚本挂载的属性（thisObject.getAnimation 的绑定属性；生命周期脚本为空串）。 */
    private currentProperty;
    private dt;
    /** 单次脚本调用的指令预算（缺省 STEP_BUDGET；callOne 每次调用前重置）。 */
    private readonly stepBudget;
    private budget;
    private constructor();
    /** 初始化 quickjs 并装好 prelude。失败返回 null（调用方退回"无脚本"路径，画面等于现状）。 */
    static create(opts: SceneScriptVmOptions): Promise<SceneScriptVm | null>;
    private keep;
    private warn;
    private installPrelude;
    /** prelude 的 key（`id:<scene对象id>` / `name:<名>` / `new:<名>`）→ scene 对象 id；非 id 形式返回 -1。 */
    private keyOf;
    private write;
    /** localStorage 键：按壁纸隔离（`we:scenescript:<wallpaperId>:<key>`）；无 id 时保持旧前缀。 */
    private storageKey;
    private anim;
    /** 装载一个模块脚本。返回 false = eval 失败（该脚本被跳过，其余继续）。
     *  `label` 用于日志（应带 scene 对象 id —— 脚本首行都是 `'use strict';`，不带 id 无法定位）。
     *  `objectId` 供 thisLayer 解析；`scriptProperties` 是 scene.json 的覆盖值（注入给 createScriptProperties）；
     *  `property` 非空 = WE 属性脚本（angles/origin/scale/color）：update(value) 收/回 Vec3。 */
    load(source: string, label?: string, objectId?: number, scriptProperties?: Record<string, unknown>, property?: ObjectScriptProperty): boolean;
    private callOne;
    /** 当前属性值的 quickjs Vec3 句柄（属性脚本入参；缺省值与 readVec 同口径）。 */
    private vecHandle;
    /** 每帧时间（供 engine.frametime）。必须在 updateAll 之前设置。 */
    setFrametime(dt: number): void;
    /** 按装载顺序调 applyUserProperties（一次）与 init。 */
    initAll(): void;
    /**
     * 按装载顺序调 update（每帧）；每个 module 一条，带 objectId/property 供 host 分类处理。
     *
     * ⚠️ 无 property 的脚本返回值是 `visible.script` 的**信号源** —— WE 语义里它就是「该对象本帧
     * 是否可见」。属性脚本（angles/origin/scale/color）的返回值已写回属性，这里一律 undefined（不混用）。
     */
    updateAll(): ScriptUpdateResult[];
    /** 派发一次媒体事件到各脚本的同名 handler；返回实际调用成功的数量。 */
    dispatchMedia(dispatch: MediaDispatch): number;
    /** 无时间线时回滚媒体回调写入的 alpha≈0（动画不跑会永久透明）；有 timeline 时留给动画淡回 1。 */
    private restoreMediaAlpha;
    /** 构造本次媒体事件对象（颜色按 Vec3 形态 {x,y,z}；每次派发新建，调用方负责 dispose）。 */
    private buildMediaEvent;
    /** thisObject.getAnimation 的播放器解析：时间线 getByProperty → getByName → AnimRegistry。 */
    private propAnim;
    /** 按装载顺序派发点击（cursorClick）。 */
    clickAll(): void;
    get loadedCount(): number;
    /** 仍可用的脚本数（抛错后被停用的不计）。 */
    get activeCount(): number;
    dispose(): void;
    /** 错误文本：quickjs 的 TypeError 只给 "not a function" 这类无主语 message，必须带 stack 才能定位。 */
    private errorText;
}
/** engine.timeOfDay 缺省值：本地时钟的当天占比（0 = 午夜，0.5 = 正午）。 */
export declare function localTimeOfDay(): number;
