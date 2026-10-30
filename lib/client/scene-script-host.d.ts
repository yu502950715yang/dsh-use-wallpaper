import { type LayerWrite } from './layer-state.js';
import type { MediaThumbnailPayload, TextureAnimationHost } from './scene-script-vm.js';
import type { TimelineAnimationSource } from './scene-timeline.js';
import type { DynamicMeshRegistry } from './dynamic-mesh.js';
import type { MediaPropertiesPayload } from '../shared/media.js';
import type { ObjectScriptProperty } from '../shared/types.js';
export interface SceneScriptHostOptions {
    /** 必须按 scene.json 的 objects 顺序传入（脚本靠 shared 互通，顺序影响 init 期状态）。 */
    scripts: Array<{
        objectId: number;
        source: string;
        /** 对象脚本的 scene.json 覆盖值（createScriptProperties 注入；缺省用脚本内默认值）。 */
        scriptProperties?: Record<string, unknown>;
        /** 对象级属性脚本挂载的属性名（有则 update(value) 收/回 Vec3；visible.script 无）。 */
        property?: ObjectScriptProperty;
    }>;
    userProperties: Record<string, unknown>;
    onWarn?: (msg: string) => void;
    /** 动态网格注册表：透传给 VM，让 createModelData/createLayer/applyData 有真实落点。 */
    dynamicMesh?: DynamicMeshRegistry;
    /** engine.registerAsset 的回调（装载期收集材质资产路径，由调用方解析成 three 材质）。 */
    onAsset?: (materialPath: string) => void;
    /** 对象级脚本的纹理动画落点（thisLayer.getTextureAnimation → player 的精灵表控制）。 */
    textureAnimation?: TextureAnimationHost;
    /** engine.timeOfDay 的 0-1 时间源（缺省本地时钟）。 */
    timeOfDay?: () => number;
    /** 壁纸 id：脚本 localStorage 按壁纸隔离（`we:scenescript:<wallpaperId>:<key>`）。 */
    wallpaperId?: string;
    /** 时间线动画源（thisObject.getAnimation 优先查它；Task 10 由 renderer 传入）。 */
    timeline?: TimelineAnimationSource;
}
export declare class SceneScriptHost {
    private readonly anims;
    private readonly state;
    private readonly vm;
    private constructor();
    /** 创建并装载。无脚本时返回一个"空 host"（tick 恒返回空表 = 画面等于现状）。
     *  quickjs 初始化失败返回 null（调用方同样退回现状）。 */
    static create(opts: SceneScriptHostOptions): Promise<SceneScriptHost | null>;
    /** 已装载的脚本数（eval 失败的不计）。 */
    get scriptCount(): number;
    /** 仍可用的脚本数（抛错后被停用的不计）。 */
    get activeCount(): number;
    /** 每帧调用：先推进动画播放器（脚本 advanceFrame 的时间源），再跑各脚本 update。
     *  返回本帧的脏写入（调用方应用后即丢弃）。
     *  只有「无 property 的对象脚本 + 布尔返回值」才是 visible 信号（属性脚本不参与）。 */
    tick(dt: number): Map<number, LayerWrite>;
    /** 派发一次点击（3798688689 的「切换按钮」靠它触发 shared.we2dSwitchScene）。 */
    click(): void;
    /** 媒体播放状态变化（0 stopped / 1 playing / 2 paused）。 */
    mediaPlayback(state: 'stopped' | 'playing' | 'paused'): void;
    /** 媒体集成开关（脚本据此隐藏/显示媒体层）。 */
    mediaStatus(enabled: boolean): void;
    /** 曲目元数据变化。 */
    mediaProperties(props: MediaPropertiesPayload): void;
    /** 封面/配色变化。 */
    mediaThumbnail(thumb: MediaThumbnailPayload): void;
    /** 外部（媒体/文本通道）向状态表写入；脚本下一帧读到。 */
    applyExternal(writes: Map<number, LayerWrite>): void;
    /** 读对象当前状态（副本）。 */
    read(objectId: number): LayerWrite;
    /** 取走并清空累计的脏写入。 */
    drainDirty(): Map<number, LayerWrite>;
    dispose(): void;
}
