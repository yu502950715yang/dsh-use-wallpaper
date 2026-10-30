// 所有绑定 `$mediaThumbnail` 的对象共享同一张 THREE.Texture：封面到达/切歌时只替换 image 并 needsUpdate。
import * as THREE from 'three';

export interface MediaThumbnailTextureSource {
  readonly texture: THREE.Texture;
  hasImage(): boolean;
  setImage(image: ImageBitmap | null): void;
  dispose(): void;
}

export function createMediaThumbnailTextureSource(): MediaThumbnailTextureSource {
  // 初始 1×1 白：封面尚未到达时显示白占位，而不是未初始化的黑纹理。
  // 用普通 Texture（而非 DataTexture）：后续换 ImageBitmap 走的是 TexImageSource 上传路径。
  const white = typeof ImageData === 'undefined'
    ? null
    : new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
  const texture = white ? new THREE.Texture(white) : new THREE.Texture();
  texture.colorSpace = THREE.SRGBColorSpace;
  // 封面尺寸任意（非 2 次幂）：关掉 mipmap，避免 WebGL 对 NPOT 纹理的采样限制。
  texture.minFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = white !== null;
  let has = false;
  let current: ImageBitmap | null = null;
  return {
    texture,
    hasImage: () => has,
    setImage(image: ImageBitmap | null): void {
      // 旧 bitmap 已被替换（GPU 数据已上传），主动 close 释放 CPU 侧内存。
      if (current && current !== image) current.close();
      current = image;
      // three r170（WebGL2）首次上传用不可变 texStorage2D：换图后尺寸变化必须 dispose 重传，
      // 否则 texSubImage2D 越界被 GL 静默丢弃 ⇒ 屏幕一直停在 1×1 白占位。
      texture.dispose();
      texture.image = image ?? white;
      texture.needsUpdate = true;
      has = image !== null;
    },
    dispose(): void {
      current?.close();
      current = null;
      texture.dispose();
    },
  };
}
