import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLOW_DEFAULTS, normalizeGlowOptions, glowLevelSizes, createGlowStage } from '../src/client/glow-stage.js';

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

/** 最小 renderer mock：只记录调用，不真编译 shader（node 无 WebGL）。 */
function mockRenderer() {
  const calls = { render: 0, setRenderTarget: [] as unknown[] };
  const renderer = {
    getClearAlpha: () => 1,
    setClearAlpha: (a: number) => { void a; },
    setRenderTarget: (t: unknown) => { calls.setRenderTarget.push(t); },
    render: () => { calls.render += 1; },
  };
  return { renderer: renderer as unknown as THREE.WebGLRenderer, calls };
}

const scene = new THREE.Scene();
const camera = new THREE.Camera();

describe('createGlowStage（RT 池与 pass 链）', () => {
  it('建 1 张 base RT + 6 张小 RT（三级各 ping-pong 一对）', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    expect(stage).toBeTruthy();
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(7);
    stage.dispose();
  });

  it('apply：主场景先渲进 base RT，最终 composite 渲到 canvas（target = null）', () => {
    const { renderer, calls } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    stage.apply(renderer, scene, camera);
    // 主场景 1 次 + 10 个 pass = 11 次 render；最后一次 composite 的目标是 null（canvas）
    expect(calls.render).toBe(11);
    expect(calls.setRenderTarget[calls.setRenderTarget.length - 1]).toBeNull();
    stage.dispose();
  });

  it('resize：按新尺寸重建 RT，并按新尺寸继续 apply', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    stage.resize(1600, 900);
    const sizes = (stage as unknown as { levelSizes: Array<{ w: number; h: number }> }).levelSizes;
    expect(sizes[0]).toEqual({ w: 800, h: 450 });
    stage.apply(renderer, scene, camera);
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(7);
    stage.dispose();
  });

  it('setOptions：只更新 uniform，不重建 RT', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    const before = (stage as unknown as { rtCount: number }).rtCount;
    stage.setOptions({ threshold: 0.5, strength: 2 });
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(before);
    expect((stage as unknown as { options: { threshold: number; strength: number } }).options)
      .toEqual({ threshold: 0.5, strength: 2 });
    stage.dispose();
  });

  it('apply 抛错 ⇒ 永久降级为直渲（同一帧内先试再回退，之后不再尝试）', () => {
    const { renderer, calls } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    // 让第一个 pass 的渲染抛错（模拟 shader 编译 / pass 失败）
    let thrown = false;
    (renderer as unknown as { render: () => void }).render = () => {
      calls.render += 1;
      if (!thrown) { thrown = true; throw new Error('boom'); }
    };
    stage.apply(renderer, scene, camera); // 首次：抛错 → 降级并直渲一次
    expect((stage as unknown as { glowFailed: boolean }).glowFailed).toBe(true);
    const afterFallback = calls.render;
    stage.apply(renderer, scene, camera); // 之后：直接直渲，不再跑 pass 链
    expect(calls.render).toBe(afterFallback + 1);
    stage.dispose();
  });

  it('dispose：释放 RT 与材质（再 apply 是 no-op，不抛）', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    stage.dispose();
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(0);
    expect(() => stage.apply(renderer, scene, camera)).not.toThrow();
  });
});
