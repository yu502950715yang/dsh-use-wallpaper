import { describe, expect, it } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';
import { resolveUtilMaterial } from '../src/client/util-material.js';

const raw = JSON.stringify({
  camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
  general: { orthogonalprojection: { width: 3840, height: 2160 } },
  objects: [
    { id: 58, name: 'Full Composition Layer', image: 'models/util/projectlayer.json', size: '3840 2160', scale: '1 1 1', origin: '1920 1080 0', alpha: 1, effects: [] },
    { id: 54, name: 'Fullscreen', image: 'models/util/fullscreenlayer.json', effects: [] },
    { id: 37, name: 'Compose', image: 'models/util/composelayer.json', size: '3840 2560', scale: '1 1 1', effects: [] },
    { id: 327, name: 'Spectrum', image: 'models/util/solidlayer_depthtest.json', size: '1000 1000', scale: '0.87 -0.98 0.1', alpha: 0, color: '0.79 0.79 0.79', effects: [] },
    { id: 99, name: 'Unknown', image: 'models/util/effectpassthrough.json' },
  ],
});

const desc = parseSceneJson(raw);

// 取 util 对象并收窄类型（Map.get 不跨调用收窄，故统一走本 helper）。
function utilObject(id: number): Extract<(typeof desc.objects)[number], { kind: 'util' }> {
  const o = desc.objects.find((x) => x.id === id);
  if (o?.kind !== 'util') throw new Error(`object ${id} is not util`);
  return o;
}

describe('util 对象解析与内置材质', () => {
  it('按 image 文件名映射 layerKind（未知 → fullscreen）', () => {
    expect(utilObject(58).layerKind).toBe('project');
    expect(utilObject(54).layerKind).toBe('fullscreen');
    expect(utilObject(37).layerKind).toBe('compose');
    expect(utilObject(327).layerKind).toBe('solid');
    expect(utilObject(99).layerKind).toBe('fullscreen');
  });
  it('solid 层解析 color/alpha（0-1 → 0-255 归一）', () => {
    const o = utilObject(327);
    // optColor：max 分量 ≤1 视为 0-1 语义 ×255（真实实现不取整，0.79 → 201.45）
    expect(o.color).toEqual([0.79 * 255, 0.79 * 255, 0.79 * 255]);
    expect(o.alpha).toBe(0);
    expect(o.brightness).toBe(1);
  });
  it('内置材质：solid 取颜色，compose/project/fullscreen 直通', () => {
    expect(resolveUtilMaterial('solid', { color: [10, 20, 30], alpha: 0.5 })).toMatchObject({ kind: 'solid', opacity: 0.5 });
    expect(resolveUtilMaterial('project').kind).toBe('passthrough');
    expect(resolveUtilMaterial('compose').kind).toBe('passthrough');
    expect(resolveUtilMaterial('fullscreen').kind).toBe('passthrough');
  });
});
