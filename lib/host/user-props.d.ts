import type { WallpaperUserProperty } from '../shared/types.js';
/** 聚合被 scene 引用的 bool/slider/color/combo 属性；坏 JSON / 缺字段返回 []，不抛。 */
export declare function collectUserProperties(project: unknown, scene: unknown): WallpaperUserProperty[];
/** v0.8 旧接口：仅保留 bool 子集，避免既有调用与测试破坏。 */
export declare function collectVisibleBoolProperties(project: unknown, scene: unknown): WallpaperUserProperty[];
