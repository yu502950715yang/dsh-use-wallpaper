// scene-instance：`$mediaThumbnail` 判定的唯一实现（scene-assets 与 media-input 共用）。
import { describe, expect, it } from 'vitest';
import { hasMediaThumbnail } from '../src/client/scene-instance.js';
import type { SceneImageObject } from '../src/shared/types.js';

describe('hasMediaThumbnail', () => {
  it('usertextures 含 $mediaThumbnail ⇒ true（type 不限）', () => {
    expect(hasMediaThumbnail({ usertextures: [{ name: '$mediaThumbnail', type: 'system' }] })).toBe(true);
    expect(hasMediaThumbnail({ usertextures: [{ name: '$mediaThumbnail', type: '' }] })).toBe(true);
  });

  it('其它系统纹理（$clock 等）不误判', () => {
    const instance = { textures: ['util/white'], usertextures: [{ name: '$clock', type: 'system' }] };
    expect(hasMediaThumbnail(instance)).toBe(false);
  });

  it('缺失/空/只有 textures/畸形 ⇒ false（不抛错）', () => {
    for (const instance of [
      undefined,
      {},
      { textures: ['util/white'] },
      { usertextures: [] },
      { usertextures: [{ name: '', type: 'system' }] },
      { usertextures: [null as unknown as { name: string; type: string }] },
      { usertextures: 'nope' },
    ]) {
      expect(hasMediaThumbnail(instance as unknown as SceneImageObject['instance'])).toBe(false);
    }
  });
});
