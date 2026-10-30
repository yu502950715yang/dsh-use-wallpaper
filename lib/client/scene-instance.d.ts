import type { SceneImageObject } from '../shared/types.js';
/** 对象是否绑定 WE 系统封面纹理（scene.json `instance.usertextures` 含 `$mediaThumbnail`）。 */
export declare function hasMediaThumbnail(instance: SceneImageObject['instance']): boolean;
