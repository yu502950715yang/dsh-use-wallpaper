// tests/object-effects.test.ts
// 对象级效果链编排的纯函数单测（分类判定 + 对象 RT 尺寸预算）。
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLinearEffectChain, resolveObjectRtSize } from '../src/client/object-effects.js';
import { resolveEffectChain } from '../src/client/shader/effect-chain.js';
import type { CompiledEffectPass } from '../src/client/shader/effect-chain.js';

// 造一个最小 CompiledEffectPass：只填本任务关心的字段（其余为占位值）。
function pass(over: Partial<CompiledEffectPass> = {}): CompiledEffectPass {
  return {
    vertSrc: '', fragSrc: '', rawVert: '', rawFrag: '',
    combos: {}, uniforms: new Map(), textureSlots: [], blendMode: 'normal',
    target: null, bind: [], fboScale: {},
    ...over,
  };
}

describe('isLinearEffectChain', () => {
  it('单 pass、无 target/bind → 线性可执行（现有 ping-pong 语义正确）', () => {
    expect(isLinearEffectChain([pass()])).toBe(true);
  });
  it('纯多 pass（无 target/bind，如 refraction 2 pass）→ 线性可执行（previous 默认语义）', () => {
    expect(isLinearEffectChain([pass(), pass()])).toBe(true);
  });
  it('pass 写出具名 RT（target 非空）→ 非线性的 RT 图链', () => {
    expect(isLinearEffectChain([pass({ target: '_rt_FullCompoBuffer1' }), pass()])).toBe(false);
  });
  it('pass 采样具名 RT（_rt_*）→ 非线性的 RT 图链', () => {
    expect(isLinearEffectChain([pass({ bind: [{ name: '_rt_FullCompoBuffer1', index: 0 }] })])).toBe(false);
  });
  it('bind 把上一 pass 输出绑在 g_Texture0（与执行器默认一致）→ 线性可执行', () => {
    expect(isLinearEffectChain([pass({ bind: [{ name: 'previous', index: 0 }] })])).toBe(true);
  });
  it('bind 把 previous 绑到 index≠0（执行器固定绑定无法表达）→ RT 图链', () => {
    expect(isLinearEffectChain([pass({ bind: [{ name: 'previous', index: 1 }] })])).toBe(false);
  });
  it('bind 引用空名（sampler2D 槽）→ RT 图链', () => {
    expect(isLinearEffectChain([pass({ bind: [{ name: '', index: 0 }] })])).toBe(false);
  });
  it('只有 fbos 声明但没有 target/bind → 仍视为线性（fbo 无消费者）', () => {
    expect(isLinearEffectChain([pass({ fboScale: { _rt_a: 4 } })])).toBe(true);
  });
  it('空链 → false（没有任何 pass 可执行）', () => {
    expect(isLinearEffectChain([])).toBe(false);
  });
});

describe('resolveObjectRtSize', () => {
  it('无预算压力时 = 世界尺寸 × dpr（四舍五入）', () => {
    expect(resolveObjectRtSize(200, 100, 2, 3840, 2160)).toEqual({ width: 400, height: 200 });
  });
  it('超出画布预算 → 等比缩小（两轴同一比例，不破坏 aspect）', () => {
    // 8000×2000 @dpr1，预算 1920×1080：s = min(1920/8000, 1080/2000) = 0.24 → 1920×480
    expect(resolveObjectRtSize(8000, 2000, 1, 1920, 1080)).toEqual({ width: 1920, height: 480 });
  });
  it('预算本身超过硬上限 4096 时按 4096 收口（4096 单边上限不被预算放宽）', () => {
    // 世界 10000×10000 @dpr1，预算 8192×8192 → capW=capH=4096 → 4096×4096
    expect(resolveObjectRtSize(10000, 10000, 1, 8192, 8192)).toEqual({ width: 4096, height: 4096 });
  });
  it('退化输入（0/负）→ 逐轴下限 1，不产生 0 尺寸 RT；负值取幅值', () => {
    // 0 轴 → 下限 1（不产生 0 尺寸 RT）；负值取幅值 → 5（**不是** 1）。
    // 本条期望与 brief 文本的 {1,1} 不一致，是 brief 自身笔误：brief 的 Step 3 实现用
    // Math.abs（幅值语义），对 -5 必然得 5。按 T4.4（commit 28c7fcc）的实测教训，
    // 负值被下限钳成 1px 正是「RT 退化、镜像内容不可见」的真实事故根因，故保留 abs、
    // 订正测试期望（同 T1 的 R5 处理方式，已在 task-2-report.md 显式请求复核）。
    expect(resolveObjectRtSize(0, -5, 1, 1920, 1080)).toEqual({ width: 1, height: 5 });
  });
  it('极端窄条保持比例（不被逐轴独立 clamp 压成方块）', () => {
    // 8192×4608 @dpr1 预算 4096×4096：s = min(4096/8192, 4096/4608) = 0.5 → 4096×2304（非 4096×4096）
    expect(resolveObjectRtSize(8192, 4608, 1, 4096, 4096)).toEqual({ width: 4096, height: 2304 });
  });
  it('非有限输入（NaN / Infinity）不产生 NaN 尺寸（否则会 new WebGLRenderTarget(NaN, NaN)）', () => {
    // Math.abs(NaN) = NaN → max(0, NaN) = NaN → round 后仍是 NaN → 非法 GL 尺寸（建不出 RT）。
    // 非有限值按 0 处理，再由逐轴下限归一到 1（与 0/负 输入同语义）。
    expect(resolveObjectRtSize(NaN, 100, 1, 1920, 1080)).toEqual({ width: 1, height: 100 });
    expect(resolveObjectRtSize(NaN, NaN, 1, 1920, 1080)).toEqual({ width: 1, height: 1 });
    const inf = resolveObjectRtSize(Infinity, 100, 1, 1920, 1080);
    expect(Number.isFinite(inf.width) && Number.isFinite(inf.height)).toBe(true);
    expect(inf).toEqual({ width: 1, height: 100 });
  });
});

// ── 全库回归：链分类的实测数字钉住（spec §2.1） ──
// 与 tests/verify-real-library.test.ts 同样的 pkg 读取方式；本机无壁纸库时整块跳过。
const WALLPAPER_DIR = 'D:/Steam/steamapps/workshop/content/431960';

function readPkgFiles(id: string): Map<string, Uint8Array> | null {
  const pkgPath = join(WALLPAPER_DIR, id, 'scene.pkg');
  if (!existsSync(pkgPath)) return null;
  const buf = readFileSync(pkgPath);
  const entries: Array<{ name: string; off: number; size: number }> = [];
  let pos = 16;
  let dataStart = -1;
  while (pos + 8 <= buf.length) {
    const nameLen = buf.readUInt32LE(pos);
    if (nameLen <= 0 || nameLen > 1024) { dataStart = pos; break; }
    const nameStart = pos + 4;
    const name = buf.toString('utf8', nameStart, nameStart + nameLen);
    const off = buf.readUInt32LE(nameStart + nameLen);
    const size = buf.readUInt32LE(nameStart + nameLen + 4);
    entries.push({ name, off, size });
    pos = nameStart + nameLen + 8;
  }
  const files = new Map<string, Uint8Array>();
  for (const e of entries) files.set(e.name, new Uint8Array(buf.subarray(dataStart + e.off, dataStart + e.off + e.size)));
  return files;
}

describe.skipIf(!existsSync(WALLPAPER_DIR))('全库效果链分类（实测数字，勿随意放宽）', () => {
  it('线性链 25 种 / 106 次引用；具名 RT 图链 9 种 / 24 次引用', async () => {
    const dirs = readdirSync(WALLPAPER_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    const linear = new Set<string>();
    const rtGraph = new Set<string>();
    let linearRefs = 0;
    let rtGraphRefs = 0;
    let unparsed = 0;
    for (const id of dirs) {
      const files = readPkgFiles(id);
      if (!files) continue;
      const scRaw = files.get('scene.json');
      if (!scRaw) continue;
      let scene: { objects?: Array<{ effects?: Array<{ file?: string; passes?: unknown[] }> }> };
      try { scene = JSON.parse(Buffer.from(scRaw).toString('utf8')); } catch { continue; }
      for (const obj of scene.objects ?? []) {
        for (const fx of obj.effects ?? []) {
          if (typeof fx.file !== 'string') continue;
          const loadFile = async (name: string) => files.get(name) ?? null;
          const chain = await resolveEffectChain({ file: fx.file, passes: fx.passes }, loadFile);
          if (!chain) { unparsed++; continue; }
          if (isLinearEffectChain(chain)) { linear.add(fx.file); linearRefs++; }
          else { rtGraph.add(fx.file); rtGraphRefs++; }
        }
      }
    }
    // 四个统计数字（供报告引用的实测输出）
    console.log(`[全库分类] 线性 ${linear.size} 种/${linearRefs} 次；具名 RT 图 ${rtGraph.size} 种/${rtGraphRefs} 次；解析失败 ${unparsed}`);
    expect({ unparsed }).toEqual({ unparsed: 0 });
    expect(linearRefs).toBe(106);
    expect(rtGraphRefs).toBe(24);
    expect(linear.size).toBe(25);
    expect(rtGraph.size).toBe(9);
  }, 120_000);
});

// ── 编排器（Task 4）：mock runner 与 host，node 环境不触碰 WebGL ──
import { ObjectEffectStage } from '../src/client/object-effects.js';
import * as THREE from 'three';
import { vi } from 'vitest';

// 编排器内部会 `new EffectRunner(...)`：真实类只在 WebGL 上下文里可用（构造即建 RT、
// setChains 会跑探针渲染编译 shader），故对本文件整体 mock 它——实例方法全是 vi.fn，
// 便于断言 setChains 的入参/次数。写法参考 tests/three-renderer.test.ts 对重型依赖的 mock。
vi.mock('../src/client/effect-runner.js', () => {
  class EffectRunner {
    setChains = vi.fn();
    setAudioSpectrumSource = vi.fn();
    update = vi.fn(async () => null);
    lastOutput = vi.fn(() => null);
    dispose = vi.fn();
  }
  return { EffectRunner };
});

// mock runner：不触碰 WebGL，只记录调用顺序与入参。
function createMockRunner() {
  const calls: Array<{ time: number; input: unknown }> = [];
  let last: THREE.Texture | null = null;
  const runner = {
    setChains: vi.fn(),
    setAudioSpectrumSource: vi.fn(),
    update: vi.fn(async (time: number, input: unknown) => {
      calls.push({ time, input });
      last = (input as THREE.WebGLRenderTarget).texture;
      return last;
    }),
    lastOutput: vi.fn(() => last),
    dispose: vi.fn(),
    _calls: calls,
  };
  return runner;
}

function createHost(entries: Array<{ id: number; rtWidth: number; rtHeight: number }>) {
  const outputs = new Map<number, THREE.Texture>();
  const resized: Array<{ id: number; w: number; h: number }> = [];
  // 与真实 player 一致的两点（否则测不出「反推世界尺寸」的不可逆 bug）：
  //   1. resizeObjectRT 会**回写** rtWidth/rtHeight（threejs-player.ts:570-571）；
  //   2. 同一对象的 rtTexture 在 resize 前后不变（player 用 rt.setSize 复用同一个 RT，
  //      其 .texture 实例不变）。
  const textures = new Map<number, THREE.Texture>();
  const textureOf = (id: number): THREE.Texture => {
    let t = textures.get(id);
    if (!t) { t = new THREE.Texture(); textures.set(id, t); }
    return t;
  };
  const host = {
    renderer: {} as THREE.WebGLRenderer,
    isolatedObjects: () => entries.map((e) => ({
      id: e.id, rtWidth: e.rtWidth, rtHeight: e.rtHeight,
      rtTexture: textureOf(e.id),
    })),
    setObjectOutput: (id: number, tex: THREE.Texture) => { outputs.set(id, tex); },
    resizeObjectRT: (id: number, w: number, h: number) => {
      const entry = entries.find((e) => e.id === id);
      if (entry) { entry.rtWidth = w; entry.rtHeight = h; }
      resized.push({ id, w, h });
    },
    _outputs: outputs,
    _resized: resized,
  };
  return host;
}

describe('ObjectEffectStage', () => {
  it('setObjectChains 为线性链创建 runner，并把对象 chains 展平后交给它', () => {
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    const chains = [[pass()], [pass()]];
    stage.setObjectChains(1, chains);
    const runners = stage.debugRunners();
    expect(runners.size).toBe(1);
    const runner = runners.get(1)!;
    expect(runner.setChains).toHaveBeenCalledTimes(1);
    const [passedChains, id, opts] = runner.setChains.mock.calls[0];
    expect(passedChains).toEqual(chains);
    expect(id).toBe('w');
    expect(opts).toEqual({ width: 100, height: 50 });
  });

  it('RT 图链整条跳过并只告警一次（按 effect 标识去重）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    stage.setObjectChains(1, [[pass({ target: '_rt_a' })]]);
    stage.setObjectChains(1, [[pass({ target: '_rt_a' })]]);
    expect(stage.rtGraphSkips()).toEqual(['_rt_a']);
    const rtGraphWarns = warn.mock.calls.filter((c) => String(c[0]).includes('具名 RT'));
    expect(rtGraphWarns).toHaveLength(1);
    expect(stage.debugRunners().has(1)).toBe(false);
    warn.mockRestore();
  });

  it('RT 图链的对象不建 runner，bindOutputs 不调用 setObjectOutput（quad 保持对象 RT 原图）', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 必须是真的具名 RT 形状（`bind: [{ name: 'previous', index: 0 }]` 按本文件既有断言是
    // **线性**的，用它做本用例等于空断言：编排器会照常 mount 建 runner）。
    stage.setObjectChains(1, [[pass({ bind: [{ name: '_rt_a', index: 0 }] })]]);
    expect(stage.debugRunners().has(1)).toBe(false);
    expect(stage.rtGraphSkips()).toContain('_rt_a');
    stage.bindOutputs();
    expect(host._outputs.size).toBe(0);
    warn.mockRestore();
  });

  it('setObjectChains 在对象尚无隔离条目时明确告警一次，且不建 runner（不暂存、不猜尺寸）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = createHost([]); // 隔离条目尚未出现＝调用顺序契约被破坏
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    stage.setObjectChains(7, [[pass()]]);
    stage.setObjectChains(7, [[pass()]]);
    // 去重告警：同一对象只打印一次（不再有「链先于条目 → 暂存」的死状态机）
    const warns = warn.mock.calls.filter((c) => String(c[0]).includes('尚无隔离条目'));
    expect(warns).toHaveLength(1);
    expect(stage.rtGraphSkips()).toEqual([]); // 线性链不是降级跳过
    expect(stage.debugRunners().has(7)).toBe(false); // 绝不猜尺寸/静默建 runner
    warn.mockRestore();
  });

  it('bindOutputs：链未就绪（lastOutput 为 null）→ 不切输出；就绪 → 切到效果输出', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    // 手工注入一个可控 runner
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    stage.bindOutputs();
    expect(host._outputs.size).toBe(0); // lastOutput 为 null
    runner.lastOutput.mockReturnValue(new THREE.Texture());
    stage.bindOutputs();
    expect(host._outputs.size).toBe(1);
  });

  it('advance 串行：同一 runner 的第二次 update 在第一次完成后才发起', async () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    let resolveFirst: (() => void) | null = null;
    const order: string[] = [];
    const runner = {
      setChains: vi.fn(), setAudioSpectrumSource: vi.fn(), dispose: vi.fn(),
      lastOutput: () => null,
      update: vi.fn(() => {
        order.push('start');
        if (!resolveFirst) {
          return new Promise<void>((res) => { resolveFirst = () => { order.push('end'); res(); }; });
        }
        return Promise.resolve();
      }),
    };
    stage.debugInjectRunner(1, runner as never);
    stage.advance(1);
    stage.advance(2);
    expect(order).toEqual(['start']); // 第二次未发起（串行）
    resolveFirst!();
    await Promise.resolve();
    await Promise.resolve();
    stage.advance(3);
    expect(order).toEqual(['start', 'end', 'start']);
  });

  it('advance 串行：第二个 runner 的 update 在第一个 settle 之前不发起（跨 runner 全局串行）', async () => {
    // 只注入一个 runner 的写法挡不住「每 runner 一个 busy 标志」的错误实现：
    // 那种实现下两个 runner 会并发交错、抢 renderer 的 RT 绑定。这里注入两个 runner。
    const host = createHost([
      { id: 1, rtWidth: 10, rtHeight: 10 },
      { id: 2, rtWidth: 10, rtHeight: 10 },
    ]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;
    const first = {
      setChains: vi.fn(), setAudioSpectrumSource: vi.fn(), dispose: vi.fn(),
      lastOutput: () => null,
      update: vi.fn(() => {
        order.push('first:start');
        return new Promise<void>((res) => { releaseFirst = () => { order.push('first:end'); res(); }; });
      }),
    };
    const second = {
      setChains: vi.fn(), setAudioSpectrumSource: vi.fn(), dispose: vi.fn(),
      lastOutput: () => null,
      update: vi.fn(() => { order.push('second:start'); return Promise.resolve(); }),
    };
    stage.debugInjectRunner(1, first as never);
    stage.debugInjectRunner(2, second as never);
    stage.advance(1);
    expect(first.update).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['first:start']);
    expect(second.update).not.toHaveBeenCalled(); // 第二个 runner 未发起（全局串行）
    releaseFirst!();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
    expect(second.update).toHaveBeenCalledTimes(1);
  });

  it('onViewportResize 按新预算等比重设 RT 尺寸（缩小→放大可逆；重挂后回退对象 RT 原图）', () => {
    const host = createHost([
      { id: 1, rtWidth: 100, rtHeight: 50 },
      { id: 2, rtWidth: 100, rtHeight: 50 }, // 无 entry/无 runner：不能被反推世界尺寸
    ]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 2, budgetWidth: 1920, budgetHeight: 1080,
    });
    // 世界尺寸的**唯一来源**是 setWorldSize（此处 50×25 = 首轮 RT 像素 / dpr）；
    // onViewportResize 只处理 entries 里已有 runner 的对象，故按契约顺序先挂链。
    stage.setWorldSize(1, 50, 25);
    stage.setObjectChains(1, [[pass()]]);
    // 新预算 400×400 @dpr2 → 100×50 不超预算 → 不变
    stage.onViewportResize(400, 400);
    expect(host._resized).toEqual([]);
    // 新预算 20×20 @dpr2 → cap 20 → 等比 s = min(20/100, 20/50) = 0.2 → 20×10
    stage.onViewportResize(20, 20);
    // 只有 id 1 被重设：id 2 无 entry 也没有 runner，直接跳过（不反推 rtWidth / dpr 当世界尺寸
    // ——那会把「已被预算收口的 RT」当世界尺寸，是不可逆的缩小）。
    expect(host._resized).toEqual([{ id: 1, w: 20, h: 10 }]);
    // 重挂（setChains 清空 last、旧 ping-pong RT 已 dispose）后必须显式回退对象 RT 原图，
    // 否则 quad 会在整个纹理重载窗口内采样已 dispose 的纹理。
    expect(host._outputs.get(1)).toBe(host.isolatedObjects().find((o) => o.id === 1)!.rtTexture);
    // 放大回去：预算再回到 400×400 → 恢复 100×50（世界尺寸始终来自 setWorldSize，故可逆）
    stage.onViewportResize(400, 400);
    expect(host._resized).toEqual([{ id: 1, w: 20, h: 10 }, { id: 1, w: 100, h: 50 }]);
  });

  it('dispose 释放全部 runner', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', dpr: 1, budgetWidth: 1920, budgetHeight: 1080,
    });
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    stage.dispose();
    expect(runner.dispose).toHaveBeenCalled();
  });
});
