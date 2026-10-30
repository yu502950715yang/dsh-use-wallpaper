import { MEDIA_THUMBNAIL_TEXTURE } from '../shared/media.js';
/** 对象是否绑定 WE 系统封面纹理（scene.json `instance.usertextures` 含 `$mediaThumbnail`）。 */
export function hasMediaThumbnail(instance) {
    const textures = instance?.usertextures;
    return Array.isArray(textures) && textures.some((u) => u?.name === MEDIA_THUMBNAIL_TEXTURE);
}
