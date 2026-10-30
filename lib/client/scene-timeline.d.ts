import type { AnimPlayback } from './scene-anim.js';
import type { LayerWrite } from './layer-state.js';
import { type WorldTransform } from './scene-graph.js';
import type { SceneDescription, TimelineAnimation, TimelineKeyframe, TimelineProperty } from '../shared/types.js';
export interface TimelineAnimationSource {
    /** 按对象 + 属性 + 动画名（'' = 当前属性绑定）取播放器；无 ⇒ null（调用方回退 AnimRegistry）。 */
    getByProperty(objectId: number, property: TimelineProperty, name: string): AnimPlayback | null;
    /** 按对象 + 动画 name 取播放器（thisLayer.getAnimation('Title')）。 */
    getByName(objectId: number, name: string): AnimPlayback | null;
}
export declare function parseTimelineAnimation(property: TimelineProperty, raw: unknown): TimelineAnimation | null;
export declare function sampleTimelineChannel(channel: TimelineKeyframe[], frame: number): number;
/** 逐通道采样；空通道（缺 c1/c2）给 0 偏移。 */
export declare function sampleTimeline(anim: TimelineAnimation, frame: number): number[];
export interface TimelineRuntimeOptions {
    desc: SceneDescription;
    /** 时间线动画的基准 = **本地**变换（renderer 在世界变换覆写前快照）。 */
    localTransforms: Map<number, WorldTransform>;
    /** 装配期的世界变换：只读参考（当前 syncWorld 全量重算，保留以对齐跨任务接口）。 */
    worldTransforms: Map<number, WorldTransform>;
    /** 把本帧时间线值写进脚本状态表（生产 = host.applyExternal）。 */
    applyLocal: (writes: Map<number, LayerWrite>) => void;
    /** 读对象当前本地状态（脚本本帧写入 + 上一帧时间线值）。 */
    readLocal: (objectId: number) => LayerWrite;
    /** 把重算后的世界变换写进渲染层（生产 = player.updateBackgroundTransform）。 */
    applyWorld: (objectId: number, wt: WorldTransform) => void;
}
export interface TimelineRuntime extends TimelineAnimationSource {
    advance(dt: number): void;
    sampleAndWrite(): void;
    applyInitial(): void;
    syncWorld(): void;
    dispose(): void;
}
export declare function createTimelineRuntime(opts: TimelineRuntimeOptions): TimelineRuntime;
