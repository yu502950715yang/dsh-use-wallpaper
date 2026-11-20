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
    // WE 纯效果对象：无 image/particle/text，只有 shape + effects（如 lightshafts 光束）。
    {
      id: 64, name: '채광 - 모서리', shape: 'quad', origin: '1681 976 0',
      effects: [{
        file: 'effects/lightshafts/effect.json',
        passes: [{
          constantshadervalues: {
            point0: '0.03802 0.11750', point1: '0.84679 0.13820',
            point2: '1.05364 0.62399', point3: '0.11815 1.05825',
          },
        }],
      }],
    },
    // 控制点全在 0..1 内：不扩展 bounds，quad 保持短边正方形（3819697503 #25 的真实形态）。
    {
      id: 65, name: 'Inside', shape: 'quad', origin: '1000 500 0',
      effects: [{
        file: 'effects/lightshafts/effect.json',
        passes: [{ constantshadervalues: { point0: '0.25 0.25', point1: '0.75 0.25', point2: '0.75 0.75', point3: '0.25 0.75' } }],
      }],
    },
    // 缺一个控制点（且 key 大小写/包装非法）：整条 bounds 不成立。
    {
      id: 66, name: 'MissingPoint', shape: 'quad', origin: '1000 500 0',
      effects: [{
        file: 'effects/lightshafts/effect.json',
        passes: [{ constantshadervalues: { point0: '0 0', point1: '1 0', point2: '1 1' } }],
      }],
    },
    // g_ 前缀 + {user,value} 包装：仍应解析出 bounds。
    {
      id: 67, name: 'Wrapped', shape: 'quad', origin: '1000 500 0',
      effects: [{
        file: 'effects/lightshafts/effect.json',
        passes: [{
          constantshadervalues: {
            g_Point0: { user: 'p0', value: '0 0' }, g_Point1: { user: 'p1', value: '1.2 0' },
            g_Point2: { user: 'p2', value: '1.2 1' }, g_Point3: { user: 'p3', value: '0 1' },
          },
        }],
      }],
    },
    // 非 lightshafts 的 DIRECTDRAW shape：不套光轴标定偏移，保持居中正方形。
    {
      id: 68, name: 'Godrays', shape: 'quad', origin: '500 500 0',
      effects: [{ file: 'effects/godrays/effect.json' }],
    },
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
    const solid = resolveUtilMaterial('solid', { color: [10, 20, 30], alpha: 0.5 });
    expect(solid).toMatchObject({ kind: 'solid', opacity: 0.5 });
    expect(solid.color).toEqual([10, 20, 30]);
    expect(resolveUtilMaterial('project').kind).toBe('passthrough');
    expect(resolveUtilMaterial('compose').kind).toBe('passthrough');
    expect(resolveUtilMaterial('fullscreen').kind).toBe('passthrough');
  });
  it('shape:"quad" 的纯效果对象按短边正方形 + WE 实测中心偏移 + lightshafts 包围盒偏移', () => {
    const o = utilObject(64);
    // 短边 2160 × bounds 宽高（bounds = [0,0,1,1] 与四点的并集）；origin 再按 bounds 中心 + WE 实测偏移
    expect(o.size![0]).toBeCloseTo(1.05364 * 2160, 3);
    expect(o.size![1]).toBeCloseTo(1.05825 * 2160, 3);
    expect(o.origin[0]).toBeCloseTo(1681 + 0.02682 * 2160 + 0.030 * 2160, 3);
    expect(o.origin[1]).toBeCloseTo(976 - 0.029125 * 2160 - 0.058 * 2160, 3);
    expect(o.layerKind).toBe('compose');
    expect(o.effectOnly).toBe(true);
    expect(o.effectBounds).toEqual([0, 0, 1.05364, 1.05825]);
    expect(o.effects).toHaveLength(1);
  });
  it('控制点全在 0..1 内：不产生 bounds，quad 保持短边正方形', () => {
    const o = utilObject(65);
    expect(o.size).toEqual([2160, 2160]);
    expect(o.origin[0]).toBeCloseTo(1000 + 0.030 * 2160, 3);
    expect(o.origin[1]).toBeCloseTo(500 - 0.058 * 2160, 3);
    expect(o.effectBounds).toBeUndefined();
  });
  it('缺控制点：不产生 bounds', () => {
    expect(utilObject(66).effectBounds).toBeUndefined();
  });
  it('g_ 前缀 + {user,value} 包装：仍解析出 bounds', () => {
    expect(utilObject(67).effectBounds).toEqual([0, 0, 1.2, 1]);
  });
  it('非 lightshafts 的 shape 对象：不套光轴标定偏移', () => {
    const o = utilObject(68);
    expect(o.origin).toEqual([500, 500, 0]);
    expect(o.size).toEqual([2160, 2160]);
    expect(o.effectOnly).toBe(true);
    expect(o.effectBounds).toBeUndefined();
  });
});
