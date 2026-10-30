// 实例系统纹理判定（纯函数，无 three）：scene-assets 与 media-input 共用同一口径。
import type { SceneImageObject } from '../shared/types.js';
import { MEDIA_THUMBNAIL_TEXTURE } from '../shared/media.js';

/** 对象是否绑定 WE 系统封面纹理（scene.json `instance.usertextures` 含 `$mediaThumbnail`）。 */
export function hasMediaThumbnail(instance: SceneImageObject['instance']): boolean {
  const textures = instance?.usertextures;
  return Array.isArray(textures) && textures.some((u) => u?.name === MEDIA_THUMBNAIL_TEXTURE);
}
