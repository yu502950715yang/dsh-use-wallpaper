// 媒体封面（$mediaThumbnail）纹理策略：无系统封面时用对象自身默认图（WE 占位图语义），
// 有封面时切共享封面纹理；纯逻辑，接线在 three-renderer。
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { mediaCoverSwitches } from '../src/client/media-cover.js';
import type { MediaCoverTarget } from '../src/client/media-cover.js';

const tex = (name: string): THREE.Texture => {
  const t = new THREE.Texture();
  t.name = name;
  return t;
};

describe('mediaCoverSwitches（封面默认图策略）', () => {
  const fallback = tex('fallback');
  const thumb = tex('thumb');

  it('无封面 ⇒ 切回对象默认纹理（WE 占位图语义，而不是白色占位）', () => {
    const targets: MediaCoverTarget[] = [{ objectId: 171, fallback }];
    expect(mediaCoverSwitches({ targets, thumbnail: thumb, hasThumbnail: false }))
      .toEqual([{ objectId: 171, texture: fallback }]);
  });

  it('有封面 ⇒ 切到共享封面纹理', () => {
    const targets: MediaCoverTarget[] = [{ objectId: 171, fallback }];
    const out = mediaCoverSwitches({ targets, thumbnail: thumb, hasThumbnail: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.texture).toBe(thumb);
  });

  it('无默认图的目标跳过（其 map 已是共享封面纹理，随 setImage 自动更新）', () => {
    const targets: MediaCoverTarget[] = [
      { objectId: 1, fallback: null },
      { objectId: 2, fallback },
    ];
    expect(mediaCoverSwitches({ targets, thumbnail: thumb, hasThumbnail: false }))
      .toEqual([{ objectId: 2, texture: fallback }]);
  });

  it('有封面但共享纹理缺失 ⇒ 维持默认纹理（不闪白）', () => {
    const targets: MediaCoverTarget[] = [{ objectId: 171, fallback }];
    const out = mediaCoverSwitches({ targets, thumbnail: null, hasThumbnail: true });
    expect(out).toEqual([{ objectId: 171, texture: fallback }]);
  });
});
