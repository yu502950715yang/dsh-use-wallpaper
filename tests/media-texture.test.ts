// media-texture：封面共享纹理的 setImage/回白/资源归属。node 环境无 DOM：用假 ImageBitmap
// 与 ImageData 桩，不做 GPU 上传（needsUpdate 只断言 version 递增）。
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { createMediaThumbnailTextureSource } from '../src/client/media-texture.js';

/** 假 ImageBitmap：只需 width/height/close（生产路径不读像素）。 */
function fakeBitmap(width = 32, height = 32) {
  return { width, height, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

// node 无 ImageData：桩出数据容器（three Texture 只把它当 image 存着，不上传）。
class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}

function withImageData(): void {
  vi.stubGlobal('ImageData', FakeImageData);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMediaThumbnailTextureSource', () => {
  it('初始 1×1 白占位；sRGB + 线性过滤；flipY=false（ImageBitmap 上传约定）', () => {
    withImageData();
    const src = createMediaThumbnailTextureSource();
    expect(src.hasImage()).toBe(false);
    expect(src.texture).toBeInstanceOf(THREE.Texture);
    // 真实封面方向的唯一开关：解码时已 imageOrientation:'flipY'，纹理侧必须 flipY=false。
    expect(src.texture.flipY).toBe(false);
    expect(src.texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(src.texture.minFilter).toBe(THREE.LinearFilter);
    expect(src.texture.generateMipmaps).toBe(false);
    expect(src.texture.image).toMatchObject({ width: 1, height: 1 });
    expect([...(src.texture.image as FakeImageData).data]).toEqual([255, 255, 255, 255]);
    src.dispose();
  });

  it('setImage：texture.image 指向 bitmap、needsUpdate 递增（version 前进）', () => {
    withImageData();
    const src = createMediaThumbnailTextureSource();
    const bitmap = fakeBitmap();
    const before = src.texture.version;
    src.setImage(bitmap);
    expect(src.texture.image).toBe(bitmap);
    expect(src.hasImage()).toBe(true);
    expect(src.texture.version).toBeGreaterThan(before);
    expect(bitmap.close).not.toHaveBeenCalled(); // 所有权已转移给纹理源
    src.dispose();
  });

  it('setImage(null)：回 1×1 白并关闭旧 bitmap', () => {
    withImageData();
    const src = createMediaThumbnailTextureSource();
    const bitmap = fakeBitmap();
    src.setImage(bitmap);
    src.setImage(null);
    expect(src.hasImage()).toBe(false);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    expect(src.texture.image).toMatchObject({ width: 1, height: 1 });
    expect([...(src.texture.image as FakeImageData).data]).toEqual([255, 255, 255, 255]);
    src.dispose();
    expect(bitmap.close).toHaveBeenCalledTimes(1); // 已关闭的旧图不重复 close
  });

  it('替换 bitmap ⇒ 旧图 close；dispose 关闭当前图且幂等', () => {
    withImageData();
    const src = createMediaThumbnailTextureSource();
    const first = fakeBitmap();
    const second = fakeBitmap();
    src.setImage(first);
    src.setImage(second);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
    src.dispose();
    expect(second.close).toHaveBeenCalledTimes(1);
    src.dispose(); // 幂等：不重复 close，不抛错
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it('无 ImageData 环境（node 缺省）也不抛错：占位为空、setImage 仍生效', () => {
    expect(typeof ImageData).toBe('undefined');
    const src = createMediaThumbnailTextureSource();
    expect(src.texture.flipY).toBe(false);
    expect(src.texture.image).toBeNull();
    const bitmap = fakeBitmap(8, 8);
    src.setImage(bitmap);
    expect(src.texture.image).toBe(bitmap);
    src.setImage(null);
    expect(src.texture.image).toBeNull();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    src.dispose();
  });
});
