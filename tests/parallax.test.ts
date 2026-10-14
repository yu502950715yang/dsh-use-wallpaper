import { describe, expect, it } from 'vitest';
import { DEFAULT_PARALLAX, POINTER_CENTER, advancePointer, parallaxShift, readParallaxConfig } from '../src/client/parallax.js';

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

describe('advancePointer（OWE UniformSource.cpp:263-274 的线性上升插值）', () => {
  const cfg = { enabled: true, amount: 1, delay: 0.5, mouseInfluence: 1 };
  it('delay=0 → 立即跟随', () => {
    const f = advancePointer({ value: POINTER_CENTER, elapsed: 0 }, { x: 1, y: 0 }, { ...cfg, delay: 0 }, 0.016);
    expect(f.value).toEqual({ x: 1, y: 0 });
  });
  it('elapsed 累积到 delay 前按比例靠近，之后完全跟随', () => {
    let f = { value: POINTER_CENTER, elapsed: 0 };
    f = advancePointer(f, { x: 1, y: 0.5 }, cfg, 0.25); // amount = 0.25/0.5 = 0.5
    expect(f.value.x).toBeCloseTo(0.75, 6);
    f = advancePointer(f, { x: 1, y: 0.5 }, cfg, 0.25); // amount = 1
    expect(f.value.x).toBeCloseTo(1, 6);
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
});
