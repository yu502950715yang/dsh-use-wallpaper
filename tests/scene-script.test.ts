import { describe, it, expect, afterEach } from 'vitest';
import { buildInitialObjectState, normalizeReadback, SceneScriptRuntime } from '../src/client/scene-script.js';

describe('buildInitialObjectState', () => {
  it('构造 origin/scale/image.alpha 嵌套状态', () => {
    const s = buildInitialObjectState([1, 2, 0], [2, 2, 1], 0.5, 1.5);
    expect(s.origin).toEqual({ x: 1, y: 2, z: 0 });
    expect(s.scale).toEqual({ x: 2, y: 2, z: 1 });
    expect(s.alpha).toBe(0.5);
    expect(s.image.alpha).toBe(0.5);
    expect(s.image.brightness).toBe(1.5);
  });
});

describe('normalizeReadback', () => {
  it('clamp imageAlpha 到 0-1', () => {
    const rb = normalizeReadback({ imageAlpha: 1.7 });
    expect(rb.imageAlpha).toBe(1);
    const rb2 = normalizeReadback({ imageAlpha: -0.2 });
    expect(rb2.imageAlpha).toBe(0);
  });

  it('仅输出有值的字段（origin 缺省保留 undefined）', () => {
    const rb = normalizeReadback({ imageAlpha: 0.4 });
    expect(rb.origin).toBeUndefined();
    expect(rb.imageAlpha).toBe(0.4);
  });

  it('origin/scale 原样保留', () => {
    const rb = normalizeReadback({ origin: { x: 1, y: 2, z: 0 }, scale: { x: 3, y: 3, z: 1 } });
    expect(rb.origin).toEqual({ x: 1, y: 2, z: 0 });
    expect(rb.scale).toEqual({ x: 3, y: 3, z: 1 });
  });
});

const BREATH_SCRIPT = `
  export class BreathingImage extends IThisPropertyObject {
    init() { this.__t = 0; this.baseAlpha = 0.8; }
    update(dt) {
      this.__t += dt;
      this.origin.x = Math.sin(this.__t) * 60;
      this.image.alpha = this.baseAlpha + 0.2 * Math.sin(this.__t * 3);
      this.scale.x = 1 + 0.05 * Math.sin(this.__t * 2);
    }
  }
`;

describe('SceneScriptRuntime (quickjs)', () => {
  let rt: InstanceType<typeof SceneScriptRuntime> | null = null;
  afterEach(() => {
    if (rt) rt.dispose();
    rt = null;
  });

  it('bind + update 读回脚本改写的 origin/image.alpha/scale（逐帧演变）', async () => {
    rt = await SceneScriptRuntime.create();
    expect(rt).not.toBeNull();
    const bound = rt!.bind(BREATH_SCRIPT, { origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1, brightness: 1 });
    expect(bound).not.toBeNull();
    const r1 = bound!.update(1 / 60);
    const r2 = bound!.update(1 / 60);
    expect(r1?.origin).toBeDefined();
    expect(r1?.imageAlpha).toBeDefined();
    // 两帧 origin.x 应都非 0（sin 驱动），且基本在小值区间
    expect(Math.abs(r1!.origin!.x)).toBeGreaterThan(0);
    expect(r1!.imageAlpha).toBeGreaterThanOrEqual(0);
    expect(r1!.imageAlpha).toBeLessThanOrEqual(1);
    // 二级帧继续演变（时间推进）
    expect(r2!.origin!.x).not.toBeCloseTo(r1!.origin!.x, 5);
  });

  it('空 script → bind 返回 null（静态渲染）', async () => {
    rt = await SceneScriptRuntime.create();
    expect(rt!.bind('', { origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1, brightness: 1 })).toBeNull();
  });

  it('无效脚本（语法错误）→ bind 返回 null，不抛错', async () => {
    rt = await SceneScriptRuntime.create();
    expect(rt!.bind('class { syntax !!!}', { origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1, brightness: 1 })).toBeNull();
  });

  it('脚本抛错 → 该对象 update 返回 null（隔离，不抛给宿主）', async () => {
    rt = await SceneScriptRuntime.create();
    const bad = `export class Bad extends IThisPropertyObject { update(dt) { throw new Error('boom'); } }`;
    const bound = rt!.bind(bad, { origin: [0, 0, 0], scale: [1, 1, 1], alpha: 1, brightness: 1 });
    expect(bound).not.toBeNull();
    expect(bound!.update(1 / 60)).toBeNull(); // 隔离：返回 null
  });
});
