import type { WallpaperUserProperty } from '../shared/types.js';
/** 从 project.json + scene.json 收集可切换的布尔用户属性；坏 JSON / 缺字段返回 []，不抛。 */
export declare function collectVisibleBoolProperties(project: unknown, scene: unknown): WallpaperUserProperty[];
