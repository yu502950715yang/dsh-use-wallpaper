// 媒体封面（`$mediaThumbnail`）纹理策略：WE 语义 = 有系统封面时用封面，没有时显示图层自身的
// 占位图（作者预置纹理）；共享封面纹理只承载「当前封面」。纯逻辑，接线见 three-renderer。
import type { Texture } from 'three';

export interface MediaCoverTarget {
  /** scene.json 对象 id。 */
  objectId: number;
  /** 对象自身解析出的默认（占位）纹理；null = 无默认图（保持共享封面纹理本身）。 */
  fallback: Texture | null;
}

export interface MediaCoverSyncInput {
  targets: readonly MediaCoverTarget[];
  /** 共享封面纹理（media-texture.ts 的源纹理）；缺失时维持默认纹理。 */
  thumbnail: Texture | null;
  hasThumbnail: boolean;
}

export interface MediaCoverSwitch {
  objectId: number;
  texture: Texture;
}

/**
 * 本次同步需要改写的「对象 → 采样纹理」列表。
 * 无默认图的目标跳过：其 map 恒为共享封面纹理，随 `setImage` 自动更新（旧行为）。
 */
export function mediaCoverSwitches(input: MediaCoverSyncInput): MediaCoverSwitch[] {
  const { targets, thumbnail, hasThumbnail } = input;
  const out: MediaCoverSwitch[] = [];
  for (const t of targets) {
    if (!t.fallback) continue;
    out.push({ objectId: t.objectId, texture: hasThumbnail ? (thumbnail ?? t.fallback) : t.fallback });
  }
  return out;
}
