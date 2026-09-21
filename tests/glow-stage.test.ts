import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { GLOW_DEFAULTS, normalizeGlowOptions, glowLevelSizes, createGlowStage } from '../src/client/glow-stage.js';

describe('normalizeGlowOptions（参数 clamp：越界 / 非法一律收敛，不抛）', () => {
  it('缺省 = 2026-09-21 网格标定档 (0.75 / 0.4)', () => {
    expect(normalizeGlowOptions()).toEqual({ threshold: 0.75, strength: 0.4 });
    expect(GLOW_DEFAULTS).toEqual({ threshold: 0.75, strength: 0.4 });
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
    expect(normalizeGlowOptions({ threshold: NaN, strength: NaN })).toEqual({ threshold: 0.75, strength: 0.4 });
    expect(normalizeGlowOptions({ threshold: 'x' as unknown as number }).threshold).toBe(0.75);
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
  const calls = {
    render: 0,
    setRenderTarget: [] as unknown[],
    hookAtRender: [] as boolean[],
    scenes: [] as unknown[], // 每次 render 的第一个实参（主场景 vs 全屏 quad）
  };
  const renderer = {
    debug: { onShaderError: undefined as ((...a: unknown[]) => void) | undefined },
    getClearAlpha: () => 1,
    setClearAlpha: (a: number) => { void a; },
    setRenderTarget: (t: unknown) => { calls.setRenderTarget.push(t); },
    render: (s?: unknown) => {
      calls.render += 1;
      calls.scenes.push(s);
      // 记录「这次 render 时 shader 失败钩子是否已安装」（钩子在位即为函数）
      calls.hookAtRender.push(typeof renderer.debug.onShaderError === 'function');
    },
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
    // 锁住 pass 链序：把每次 setRenderTarget 的目标换成「首次出现编号」，node 无 WebGL 也能全序比对。
    const seen = new Map<unknown, string>();
    const seq = calls.setRenderTarget.map((t) => {
      if (t === null) return 'canvas';
      let label = seen.get(t);
      if (label === undefined) { label = `rt${seen.size}`; seen.set(t, label); }
      return label;
    });
    expect(seq).toEqual([
      'rt0', 'canvas',  // 1) 主场景 → base RT
      'rt1', 'canvas',  // 2) bright-pass → L1a
      'rt2', 'canvas',  // 3) L1 H → L1b
      'rt1', 'canvas',  // 4) L1 V → L1a（ping-pong 回写 a）
      'rt3', 'canvas',  // 5) L1a → L2a（降采样）
      'rt4', 'canvas',  // 6) L2 H → L2b
      'rt3', 'canvas',  // 7) L2 V → L2a
      'rt5', 'canvas',  // 8) L2a → L3a（降采样）
      'rt6', 'canvas',  // 9) L3 H → L3b
      'rt5', 'canvas',  // 10) L3 V → L3a（ping-pong 回写 a）
      'canvas',         // 11) composite：base + L1a/L2a/L3a 等权累加 → canvas
    ]);
    expect(seen.size).toBe(7); // 1 base + 3 级 × ping-pong 2
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

  it('apply 抛错 ⇒ 永久降级为直渲；失败帧**不重复渲染主场景**（base 内容直接贴回 canvas）', () => {
    const { renderer, calls } = mockRenderer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // 降级告警故意触发，静音
    const stage = createGlowStage(1280, 720)!;
    // 第 2 次 render（bright-pass）抛错 → 模拟运行期 pass 异常；base 那次（第 1 次）已完成
    let n = 0;
    (renderer as unknown as { render: (s?: unknown) => void }).render = (s?: unknown) => {
      calls.render += 1;
      calls.scenes.push(s);
      n += 1;
      if (n === 2) throw new Error('boom');
    };
    stage.apply(renderer, scene, camera); // 首次：pass 抛错 → 降级
    expect((stage as unknown as { glowFailed: boolean }).glowFailed).toBe(true);
    // 主场景本帧只渲一次（= base 那次）；回退是把 base 贴到 canvas（传的是 quad）
    expect(calls.scenes.filter((s) => s === scene).length).toBe(1);
    expect(calls.scenes[calls.scenes.length - 1]).not.toBe(scene);
    const afterFallback = calls.render;
    stage.apply(renderer, scene, camera); // 之后：直接直渲，不再跑 pass 链
    expect(calls.render).toBe(afterFallback + 1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    stage.dispose();
  });

  it('base 那次渲染本身抛错（内容不可信）⇒ 回退为直渲一次，仍永久降级', () => {
    const { renderer, calls } = mockRenderer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stage = createGlowStage(1280, 720)!;
    let thrown = false;
    (renderer as unknown as { render: (s?: unknown) => void }).render = (s?: unknown) => {
      calls.render += 1;
      calls.scenes.push(s);
      if (!thrown) { thrown = true; throw new Error('boom'); }
    };
    stage.apply(renderer, scene, camera);
    expect((stage as unknown as { glowFailed: boolean }).glowFailed).toBe(true);
    expect(calls.scenes.filter((s) => s === scene).length).toBe(2); // base（抛错）+ 直渲回退
    stage.apply(renderer, scene, camera);
    expect(calls.scenes.filter((s) => s === scene).length).toBe(3); // 之后每帧只直渲一次
    warn.mockRestore();
    stage.dispose();
  });

  it('钩子窗口只覆盖我们自己的材质：主场景 → base RT 那一次渲染发生在装钩子之前', () => {
    const { renderer, calls } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    stage.apply(renderer, scene, camera);
    expect(calls.render).toBe(11);
    // 第 1 次 render = 主场景 → base RT（钩子未装）；其后 10 个 pass 都在钩子生效期内
    expect(calls.hookAtRender[0]).toBe(false);
    expect(calls.hookAtRender.length).toBe(11);
    expect(calls.hookAtRender.slice(1).every((v) => v)).toBe(true);
    expect((stage as unknown as { glowFailed: boolean }).glowFailed).toBe(false);
    stage.dispose();
  });

  it('shader 链接失败（three 只调 onShaderError、不抛）⇒ 同样永久降级为直渲 + 告警带 GLSL 详情', () => {
    const { renderer, calls } = mockRenderer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const stage = createGlowStage(1280, 720)!;
    const r = renderer as unknown as {
      render: () => void;
      debug: { onShaderError?: (...a: unknown[]) => void };
    };
    // 模拟 three：LINK_STATUS === false 时只调 renderer.debug.onShaderError，然后正常返回（不抛）
    const gl = {
      getShaderInfoLog: (s: unknown) => (s === 'fs' ? 'ERROR: 0:12 syntax error' : ''),
      getProgramInfoLog: () => 'link failed',
    };
    r.render = () => {
      calls.render += 1;
      r.debug.onShaderError?.(gl, 'program', 'vs', 'fs');
    };
    stage.apply(renderer, scene, camera);
    expect((stage as unknown as { glowFailed: boolean }).glowFailed).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shader 编译/链接失败'));
    // 钩子在位时 three 会跳过它自带的详细 console.error ⇒ 我们自取 GLSL info log（含 program log）
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('syntax error'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('link failed'));
    expect(r.debug.onShaderError).toBeUndefined(); // 首帧结束即摘钩子
    const afterFirst = calls.render;
    stage.apply(renderer, scene, camera); // 下一次：直渲短路，只剩 1 次 render
    expect(calls.render).toBe(afterFirst + 1);
    warn.mockRestore();
    stage.dispose();

    // 只在首帧挂钩：成功首帧后不再挂 —— 第 2 帧里别的材质（场景效果链）编译失败不该误判成 Glow 失败
    const second = mockRenderer();
    const stage2 = createGlowStage(1280, 720)!;
    stage2.apply(second.renderer, scene, camera); // 首帧：mock 不调钩子 ⇒ glow 视为编译成功
    const r2 = second.renderer as unknown as {
      render: () => void;
      debug: { onShaderError?: (...a: unknown[]) => void };
    };
    let hookAliveOnSecondFrame = false;
    r2.render = () => {
      second.calls.render += 1;
      if (r2.debug.onShaderError) hookAliveOnSecondFrame = true; // 还挂着钩子就会被观测到
    };
    stage2.apply(second.renderer, scene, camera);
    expect(hookAliveOnSecondFrame).toBe(false);
    expect((stage2 as unknown as { glowFailed: boolean }).glowFailed).toBe(false);
    stage2.dispose();
  });

  it('dispose：释放 RT 与材质（再 apply 是 no-op，不抛）', () => {
    const { renderer } = mockRenderer();
    const stage = createGlowStage(1280, 720)!;
    stage.dispose();
    expect((stage as unknown as { rtCount: number }).rtCount).toBe(0);
    expect(() => stage.apply(renderer, scene, camera)).not.toThrow();
  });
});
