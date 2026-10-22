import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PARALLAX, POINTER_CENTER, advancePointer, effectPointerUniforms, parallaxShift, readParallaxConfig,
} from '../src/client/parallax.js';
import type { PointerFollow } from '../src/client/parallax.js';

describe('readParallaxConfig', () => {
  it('缺省 = OWE 解析器缺省（关 / 0 / 0 / 0）', () => {
    expect(readParallaxConfig(undefined)).toEqual(DEFAULT_PARALLAX);
    expect(readParallaxConfig({})).toEqual(DEFAULT_PARALLAX);
  });
  it('读四个字段并容错非数值', () => {
    expect(readParallaxConfig({ cameraparallax: true, cameraparallaxamount: 0.5, cameraparallaxdelay: 0.1, cameraparallaxmouseinfluence: 1 }))
      .toEqual({ enabled: true, amount: 0.5, delay: 0.1, mouseInfluence: 1 });
    expect(readParallaxConfig({ cameraparallax: 'yes', cameraparallaxamount: 'x' }))
      .toEqual({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
  });
});

describe('advancePointer（OWE UniformSource.cpp:249-274 的指针滞后插值）', () => {
  const cfg = { enabled: true, amount: 1, delay: 0.5, mouseInfluence: 1 };
  it('delay=0 → 立即跟随', () => {
    const f = advancePointer({ value: POINTER_CENTER, elapsed: 0 }, { x: 1, y: 0 }, { ...cfg, delay: 0 }, 0.016);
    expect(f.value).toEqual({ x: 1, y: 0 });
  });
  // delay>0 = 时间常数 ≈ delay 的一阶平滑：每帧按 min(dt,delay)/delay 靠近。
  // ⚠️ 不得写成 elapsed 跨帧累积到 delay —— 那样 amount 会在 delay 秒后永久变成 1，滞后感只剩
  // 第一次移动（Task 1 评审转交项 1：OWE 的 SetPointerInput 每帧都在重置滞后时钟）。
  it('delay>0：每帧按 min(dt,delay)/delay 靠近（滞后感每次移动都在，不会一次耗光）', () => {
    let f: PointerFollow = { value: { ...POINTER_CENTER }, elapsed: 0 };
    f = advancePointer(f, { x: 1, y: 0.5 }, cfg, 0.25); // amount = 0.25/0.5 = 0.5
    expect(f.value.x).toBeCloseTo(0.75, 6);
    f = advancePointer(f, { x: 1, y: 0.5 }, cfg, 0.25); // 仍是 0.5（累积式会变成 1）
    expect(f.elapsed).toBeCloseTo(0.25, 6);
    expect(f.value.x).toBeCloseTo(0.875, 6);
    // 指针不动也照样逐帧靠近：合成上是滞后 ≈ delay 的收尾，不是硬跟手。
    for (let i = 0; i < 12; i++) f = advancePointer(f, { x: 1, y: 0.5 }, cfg, 0.25);
    expect(f.value.x).toBeGreaterThan(0.999);
  });
  // 滞后时钟封顶到 delay（Task 1 评审：手改掉 `Math.min(…, delay)` 后原 9 条用例全绿）。
  it('滞后时钟封顶到 delay：dt 超过 delay ⇒ amount = 1（否则 amount > 1、指针过冲）', () => {
    const target = { x: 1, y: 0.5 };
    // dt == delay 只会走到边界（去掉 Math.min 也通过 ⇒ 无判别力）；真正钉住封顶的是下一条 dt > delay 过冲例。
    const f = advancePointer({ value: { ...POINTER_CENTER }, elapsed: 0.4 }, target, cfg, 0.5);
    expect(f.elapsed).toBeCloseTo(0.5, 6);
    expect(f.value).toEqual(target);
    // dt > delay（长帧）：不封顶则 elapsed 0.75、amount 1.5 ⇒ 指针冲过目标
    const over = advancePointer({ value: { ...POINTER_CENTER }, elapsed: 0 }, target, cfg, 0.75);
    expect(over.elapsed).toBeCloseTo(0.5, 6);
    expect(over.value).toEqual(target);
  });
});

describe('parallaxShift（OWE UniformSource.cpp:399-415）', () => {
  const cfg = { enabled: true, amount: 1, delay: 0, mouseInfluence: 1 };
  it('鼠标居中且对象在原点 → 无位移', () => {
    expect(parallaxShift({ pointer: POINTER_CENTER, orthoW: 1920, orthoH: 1080, nodeX: 0, nodeY: 0, camX: 0, camY: 0, depth: [1, 1], cfg }))
      .toEqual([0, 0]);
  });
  it('鼠标右移 px=1 → shift_x 为负（对象向左，OWE 方向约定）', () => {
    const [sx] = parallaxShift({ pointer: { x: 1, y: 0.5 }, orthoW: 1920, orthoH: 1080, nodeX: 0, nodeY: 0, camX: 0, camY: 0, depth: [1, 1], cfg });
    expect(sx).toBeCloseTo((0.5 - 1) * 1920, 6);
  });
  it('鼠标下移 py=1 → shift_y 为正', () => {
    const [, sy] = parallaxShift({ pointer: { x: 0.5, y: 1 }, orthoW: 1920, orthoH: 1080, nodeX: 0, nodeY: 0, camX: 0, camY: 0, depth: [1, 1], cfg });
    expect(sy).toBeCloseTo(540, 6);
  });
  it('结构项：离屏中心越远、摆幅越大（乘 depth × amount）', () => {
    const [sx] = parallaxShift({ pointer: POINTER_CENTER, orthoW: 1920, orthoH: 1080, nodeX: 300, nodeY: 0, camX: 0, camY: 0, depth: [0.5, 0], cfg: { ...cfg, amount: 2 } });
    expect(sx).toBeCloseTo(300, 6);
  });
  it('depth 为 0 或总开关关 → 恒 0', () => {
    const base = { pointer: { x: 1, y: 1 }, orthoW: 1920, orthoH: 1080, nodeX: 100, nodeY: 100, camX: 0, camY: 0, cfg };
    expect(parallaxShift({ ...base, depth: [0, 0] })).toEqual([0, 0]);
    expect(parallaxShift({ ...base, depth: [1, 1], cfg: { ...cfg, enabled: false } })).toEqual([0, 0]);
  });
  // 单轴 0 深度：`0 × amount × 负数` 是 **-0**（IEEE-754），会让下游 `toEqual` 式精确断言假失败。
  it('单轴 0 深度 ⇒ 零轴恒为 +0（不是 -0）', () => {
    const [sx, sy] = parallaxShift({
      pointer: POINTER_CENTER, orthoW: 1920, orthoH: 1080, nodeX: 100, nodeY: -100, camX: 0, camY: 0, depth: [1, 0], cfg,
    });
    expect(sx).toBeCloseTo(100, 6);
    expect(Object.is(sy, 0)).toBe(true);
    expect([sx, sy]).toEqual([100, 0]);
  });
});

// ===== v0.8.2 F18：效果 shader 全局 uniform 的取值口径 =====
// 官方文档：g_PointerPosition = 归一化屏幕坐标（[0,1]）；g_ParallaxPosition = 归一化视差偏移
// （0.5 = 无偏移）。参考实现（WPShaderValueUpdater）按 mouseinfluence 缩放、y 翻到向上；
// 这里取**中心化后**的偏移（0.5 为中性），与 depthparallax 的 `para*2-1` 用法一致。
describe('effectPointerUniforms（g_PointerPosition / g_ParallaxPosition 取值）', () => {
  const cfg = { enabled: true, amount: 1, delay: 0, mouseInfluence: 1 };

  it('pointerPosition = 原始归一化指针（y 向下，与 pointer-input 同一坐标空间）', () => {
    const u = effectPointerUniforms({ x: 0.2, y: 0.8 }, cfg);
    expect(u.pointerPosition).toEqual([0.2, 0.8]);
  });

  it('parallaxPosition：关视差 → 中性 0.5（视差偏移为零）', () => {
    expect(effectPointerUniforms({ x: 0.2, y: 0.2 }, { ...cfg, enabled: false }).parallaxPosition).toEqual([0.5, 0.5]);
    expect(effectPointerUniforms({ x: 0.2, y: 0.2 }, DEFAULT_PARALLAX).parallaxPosition).toEqual([0.5, 0.5]);
  });

  it('parallaxPosition：开视差 → 中心化后按 mouseInfluence 缩放，且 y 翻到向上', () => {
    // 指针左上 (0.2,0.2) → 视差偏移 (-0.3,-0.3) → x=-0.3、y 翻成 +0.3
    expect(effectPointerUniforms({ x: 0.2, y: 0.2 }, cfg).parallaxPosition).toEqual([0.2, 0.8]);
    expect(effectPointerUniforms(POINTER_CENTER, cfg).parallaxPosition).toEqual([0.5, 0.5]);
    // mouseInfluence = 0 → 无偏移（与关视差同值，但不依赖 enabled 分支）
    expect(effectPointerUniforms({ x: 1, y: 0 }, { ...cfg, mouseInfluence: 0 }).parallaxPosition).toEqual([0.5, 0.5]);
  });

  it('第三个参数 = 插值后的视差指针：只影响 parallaxPosition，pointerPosition 仍取原始指针', () => {
    const u = effectPointerUniforms({ x: 0.9, y: 0.1 }, cfg, { x: 0.2, y: 0.2 });
    expect(u.pointerPosition).toEqual([0.9, 0.1]);
    expect(u.parallaxPosition).toEqual([0.2, 0.8]);
  });
});
