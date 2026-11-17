// bright-pass 与合成软膝的纯函数口径（2026-11-17，A 方案：对齐 WE 的 downsample_quarter_bloom）。
// 背景：旧口径 `(luma - t) / (1 - t)` 在 t=0.5 / 0.65 时把 bloom / Glow 分别放大 2× / 2.86×；
// WE 的 `assets/shaders/downsample_quarter_bloom.frag` 是 `saturate(max(rgb) - threshold)`，不除
// `(1 - t)`，且用 **max 通道**（不是 luma）判阈值。
import { describe, it, expect } from 'vitest';
import { brightPassFactor, shoulderCurve, softShoulder, SHOULDER_KNEE } from '../src/client/glow-math.js';

describe('brightPassFactor（WE 口径：saturate(max(r,g,b) - threshold)）', () => {
  it('低于 / 等于阈值 → 0（阈值是硬门槛，不是缩放基准）', () => {
    expect(brightPassFactor(0.4, 0.4, 0.4, 0.5)).toBe(0);
    expect(brightPassFactor(0.5, 0.5, 0.5, 0.5)).toBe(0);
    expect(brightPassFactor(0, 0, 0, 0.65)).toBe(0);
  });

  it('纯白在 t=0.5 时是 0.5，不是旧口径的 1.0（差 2 倍）', () => {
    expect(brightPassFactor(1, 1, 1, 0.5)).toBeCloseTo(0.5, 10);
  });

  it('纯白在默认光晕阈值 0.65 时是 0.35，不是旧口径的 1.0（差 2.857 倍）', () => {
    expect(brightPassFactor(1, 1, 1, 0.65)).toBeCloseTo(1 - 0.65, 10);
  });

  it('用 max 通道判阈值：纯蓝高光必须发光（旧 luma 口径会判 0）', () => {
    // luma(0,0,1) = 0.114 < 0.5 ⇒ 旧口径 0；WE 口径 max=1 ⇒ 0.5
    expect(brightPassFactor(0, 0, 1, 0.5)).toBeCloseTo(0.5, 10);
    expect(brightPassFactor(0, 1, 0, 0.5)).toBeCloseTo(0.5, 10);
    expect(brightPassFactor(1, 0, 0, 0.5)).toBeCloseTo(0.5, 10);
  });

  it('上限收敛到 1（输入/阈值任意越界都不外溢）', () => {
    expect(brightPassFactor(1, 1, 1, 0)).toBe(1);
    expect(brightPassFactor(2, 0, 0, 0.5)).toBe(1);
    expect(brightPassFactor(1, 0, 0, -5)).toBe(1); // 阈值负值按 0 处理
  });

  it('阈值 1 / NaN 不退化解：1 = 全灭，NaN 回退 0（与 uniform 归一化一致）', () => {
    expect(brightPassFactor(1, 1, 1, 1)).toBe(0);
    expect(brightPassFactor(1, 1, 1, NaN)).toBe(1);
  });

  it('连续：跨阈值两侧不会跳变（阈值处左右极限都是 0）', () => {
    const t = 0.62;
    expect(brightPassFactor(t - 1e-6, t - 1e-6, t - 1e-6, t)).toBe(0);
    expect(brightPassFactor(t + 1e-6, t + 1e-6, t + 1e-6, t)).toBeLessThan(1e-5);
  });
});

describe('shoulderCurve（软膝：< knee 恒等，之上指数压向 1）', () => {
  it('knee 以下恒等（0 / 0.5 / 0.9 原样返回）', () => {
    expect(shoulderCurve(0)).toBe(0);
    expect(shoulderCurve(0.5)).toBe(0.5);
    expect(shoulderCurve(0.9)).toBe(0.9);
  });

  it('knee 处 C1 连续（左右导数都 ≈ 1）', () => {
    const h = 1e-5;
    const k = SHOULDER_KNEE;
    const left = (shoulderCurve(k) - shoulderCurve(k - h)) / h;
    const right = (shoulderCurve(k + h) - shoulderCurve(k)) / h;
    expect(left).toBeCloseTo(1, 3);
    expect(right).toBeCloseTo(1, 3);
  });

  it('严格单调递增、渐近但不越过 1', () => {
    let prev = -1;
    for (let x = 0; x <= 4; x += 0.05) {
      const y = shoulderCurve(x);
      expect(y).toBeGreaterThanOrEqual(prev);
      expect(y).toBeLessThan(1);
      prev = y;
    }
    expect(shoulderCurve(1.0)).toBeGreaterThan(SHOULDER_KNEE);
    expect(shoulderCurve(1.0)).toBeLessThan(1);
    expect(shoulderCurve(3)).toBeGreaterThan(shoulderCurve(1));
    // 远端只能保证「不越过 1」：x=10 时 exp(-91) 在 double 里已下溢，结果恰为 1
    expect(shoulderCurve(10)).toBeLessThanOrEqual(1);
  });

  it('压缩比随超出量增大（1.2 的损失小于 2.0）', () => {
    expect(1.2 - shoulderCurve(1.2)).toBeLessThan(2.0 - shoulderCurve(2.0));
  });
});

describe('softShoulder（只压光晕新增的能量，不压暗底图）', () => {
  it('底图已纯白时保持纯白（否则 255 会被压成 246）', () => {
    expect(softShoulder(1, 0.5)).toBe(1);
    expect(softShoulder(1, 0)).toBe(1);
    expect(softShoulder(0.99, 2)).toBeGreaterThanOrEqual(0.99);
  });

  it('knee 以下 = base + added（恒等，不动正常亮度）', () => {
    expect(softShoulder(0.5, 0.2)).toBeCloseTo(0.7, 10);
    expect(softShoulder(0.2, 0.1)).toBeCloseTo(0.3, 10);
  });

  it('超过 knee 的加法被压缩：0.5 + 0.7 → 接近但不到 1', () => {
    const y = softShoulder(0.5, 0.7);
    expect(y).toBeGreaterThan(0.95);
    expect(y).toBeLessThan(1);
  });

  it('永不暗于底图（逐个 base 扫一遍）', () => {
    for (let b = 0; b <= 1; b += 0.05) {
      for (const a of [0, 0.1, 0.5, 1, 2]) {
        expect(softShoulder(b, a)).toBeGreaterThanOrEqual(b - 1e-12);
      }
    }
  });
});
