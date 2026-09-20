import { describe, it, expect } from 'vitest';
import { GLOW_DEFAULTS, normalizeGlowOptions, glowLevelSizes } from '../src/client/glow-stage.js';

describe('normalizeGlowOptions（参数 clamp：越界 / 非法一律收敛，不抛）', () => {
  it('缺省 = 离线实验 A 档 (0.65 / 1.0)', () => {
    expect(normalizeGlowOptions()).toEqual({ threshold: 0.65, strength: 1.0 });
    expect(GLOW_DEFAULTS).toEqual({ threshold: 0.65, strength: 1.0 });
  });

  it('threshold 上界收敛到 0.99（不允许 1，否则除零）', () => {
    expect(normalizeGlowOptions({ threshold: 1 }).threshold).toBe(0.99);
    expect(normalizeGlowOptions({ threshold: 5 }).threshold).toBe(0.99);
  });

  it('threshold 负值收敛到 0', () => {
    expect(normalizeGlowOptions({ threshold: -0.5 }).threshold).toBe(0);
  });

  it('strength 收敛到 [0, 4]', () => {
    expect(normalizeGlowOptions({ strength: -1 }).strength).toBe(0);
    expect(normalizeGlowOptions({ strength: 99 }).strength).toBe(4);
  });

  it('NaN / 非数字回退缺省（不把 NaN 灌进 uniform）', () => {
    expect(normalizeGlowOptions({ threshold: NaN, strength: NaN })).toEqual({ threshold: 0.65, strength: 1.0 });
    expect(normalizeGlowOptions({ threshold: 'x' as unknown as number }).threshold).toBe(0.65);
  });

  it('区间内的值原样保留', () => {
    expect(normalizeGlowOptions({ threshold: 0.5, strength: 2 })).toEqual({ threshold: 0.5, strength: 2 });
  });
});

describe('glowLevelSizes（三级降采样尺寸：逐级取半、最小 1px）', () => {
  it('常规视口 1280×720 → 640×360 / 320×180 / 160×90', () => {
    expect(glowLevelSizes(1280, 720)).toEqual([
      { w: 640, h: 360 },
      { w: 320, h: 180 },
      { w: 160, h: 90 },
    ]);
  });

  it('3440×1440 → 1720×720 / 860×360 / 430×180', () => {
    expect(glowLevelSizes(3440, 1440)).toEqual([
      { w: 1720, h: 720 },
      { w: 860, h: 360 },
      { w: 430, h: 180 },
    ]);
  });

  it('极窄视口不会出现 0（最小 1px）', () => {
    expect(glowLevelSizes(4, 4)).toEqual([{ w: 2, h: 2 }, { w: 1, h: 1 }, { w: 1, h: 1 }]);
    expect(glowLevelSizes(1, 1)).toEqual([{ w: 1, h: 1 }, { w: 1, h: 1 }, { w: 1, h: 1 }]);
  });

  it('非 2 的幂尺寸向下取整', () => {
    expect(glowLevelSizes(1921, 1081)).toEqual([{ w: 960, h: 540 }, { w: 480, h: 270 }, { w: 240, h: 135 }]);
  });
});
