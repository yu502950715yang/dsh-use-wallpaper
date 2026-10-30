import type { AnimPlayback } from './scene-anim.js';
import type { TimelineAnimation, TimelineKeyframe, TimelineProperty } from '../shared/types.js';
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
