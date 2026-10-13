// tests/object-effects.test.ts
// 对象级效果链编排的纯函数单测（分类判定 + 对象 RT 尺寸预算）。
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLinearEffectChain, referencesFrameSnapshot } from '../src/client/object-effects.js';
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

// 尺寸口径（objectRtSize）与屏幕密度（screenScalePx）是 object-range.ts 的纯函数，
// 其单测见 tests/object-range.test.ts；本文件只测编排器对尺寸口径的**消费**。

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
  it('全库效果链可分类：两个桶都非空、零解析失败（计数仅打印，不钉数字）', async () => {
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
    // ⚠️ 只断言「两个桶都非空」：这些计数是**本机壁纸库的快照**，会随素材漂移
    //（106→142 次、25→41 种、24→27 次、9→10 种；三方 A/B 已证与代码无关，见 AGENT.md §7.11）。
    // 精确计数与分类语义由确定性层 tests/synthetic-library.test.ts 负责。
    expect(linearRefs).toBeGreaterThan(0);
    expect(rtGraphRefs).toBeGreaterThan(0);
    expect(linear.size).toBeGreaterThan(0);
    expect(rtGraph.size).toBeGreaterThan(0);
  }, 120_000);
});

// ── 编排器（Task 4）：mock runner 与 host，node 环境不触碰 WebGL ──
import { ObjectEffectStage, weVRowOrderLoader } from '../src/client/object-effects.js';
import { isolatedRtSize, ISOLATED_RT_BYTES_PER_PX, ISOLATED_RT_BUDGET_BYTES } from '../src/client/object-range.js';
import * as THREE from 'three';
import { vi } from 'vitest';

// 编排器内部会 `new EffectRunner(...)`：真实类只在 WebGL 上下文里可用（构造即建 RT、
// setChains 会跑探针渲染编译 shader），故对本文件整体 mock 它——实例方法全是 vi.fn，
// 便于断言 setChains 的入参/次数。写法参考 tests/three-renderer.test.ts 对重型依赖的 mock。
// `runnerCtorArgs` 记录构造参数（用 vi.hoisted 才能在 mock 工厂里引用）——用于断言
// 「纹理槽加载器按 WE v 约定注入」这条接线。
const runnerCtorArgs = vi.hoisted(() => [] as unknown[][]);
vi.mock('../src/client/effect-runner.js', async (importOriginal) => {
  // 纯函数（如 planSamplesFrameSnapshot / slotBoundByBind）保持**真实实现**：段边界消费者的判定
  // 口径必须与生产同源（同一份计划 `pp.bindings`），在 mock 里另写一份会在两侧漂移时仍然全绿。
  const actual = await importOriginal<typeof import('../src/client/effect-runner.js')>();
  class EffectRunner {
    constructor(...args: unknown[]) { runnerCtorArgs.push(args); }
    setChains = vi.fn();
    setPlan = vi.fn();
    setAudioSpectrumSource = vi.fn();
    update = vi.fn(async () => null);
    lastOutput = vi.fn(() => null);
    dispose = vi.fn();
  }
  return { ...actual, EffectRunner };
});

// mock runner：不触碰 WebGL，只记录调用顺序与入参。
function createMockRunner() {
  const calls: Array<{ time: number; input: unknown; frameTex: unknown }> = [];
  let last: THREE.Texture | null = null;
  const runner = {
    setChains: vi.fn(),
    setPlan: vi.fn(),
    setAudioSpectrumSource: vi.fn(),
    update: vi.fn(async (time: number, input: unknown, frameTex: unknown = null) => {
      calls.push({ time, input, frameTex });
      last = (input as THREE.WebGLRenderTarget).texture;
      return last;
    }),
    lastOutput: vi.fn(() => last),
    dispose: vi.fn(),
    _calls: calls,
  };
  return runner;
}

function createHost(
  entries: Array<{ id: number; rtWidth: number; rtHeight: number }>,
  opts: { frameSnapshotVersion?: () => number } = {},
) {
  const outputs = new Map<number, THREE.Texture>();
  const resized: Array<{ id: number; w: number; h: number }> = [];
  const frameConsumers: number[] = [];
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
    // Task 5：段边界通知未携带纹理时编排器的拉取入口（缺省 null = 无快照）。
    captureFullFrame: (): THREE.Texture | null => null,
    // Task 6：快照代号的实时读取入口（真 player 返回 FrameCapture.snapshotVersion）；不传 = 宿主
    // 不提供代号 ⇒ 编排器退回「不因版本作废」（与接线前同语义）。
    frameSnapshotVersion: opts.frameSnapshotVersion,
    // Task 5：引用整帧快照的链会把自己登记为段边界消费者（player 的既有公开方法）。
    registerFrameConsumer: (objectId: number) => { frameConsumers.push(objectId); },
    _outputs: outputs,
    _resized: resized,
    _frameConsumers: frameConsumers,
  };
  return host;
}

describe('ObjectEffectStage', () => {
  it('纹理槽加载器按 WE v 约定注入（rowOrder:topDown，与对象 RT 的 v 约定同一套）', async () => {
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
    });
    stage.setObjectChains(1, [[pass()]]);
    // 构造注入（mock EffectRunner 记录构造参数）：第 4 个参数带 load 加载器
    expect(runnerCtorArgs.length).toBeGreaterThan(0);
    const opts = runnerCtorArgs[0][3] as { load?: (u: string, o?: object) => unknown };
    expect(typeof opts.load).toBe('function');
    // 该加载器必须把 rowOrder:'topDown' 叠到调用方 opts 上（不改 alphaPriority 语义）
    const seen: Array<{ url: string; opts?: object }> = [];
    await (weVRowOrderLoader(async (url, o) => { seen.push({ url, opts: o }); return null; })('u', { alphaPriority: false }));
    expect(seen[0]).toEqual({ url: 'u', opts: { alphaPriority: false, rowOrder: 'topDown' } });
  });

  it('setObjectChains 为线性链创建 runner，并把对象 chains 展平后交给它', () => {
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
    });
    const chains = [[pass()], [pass()]];
    stage.setObjectChains(1, chains);
    const runners = stage.debugRunners();
    expect(runners.size).toBe(1);
    const runner = runners.get(1)!;
    expect(runner.setPlan).toHaveBeenCalledTimes(1);
    const [plan, passedChains, id, opts] = runner.setPlan.mock.calls[0];
    expect(plan.namedTargets).toEqual([]); // 线性链没有具名 RT
    expect(passedChains).toEqual(chains);
    expect(id).toBe('w');
    expect(opts).toEqual({ width: 100, height: 50 });
  });

  it('RT 图链照常挂载：setPlan 收到含具名 RT 的计划（不再整链跳过）', () => {
    const host = createHost([{ id: 1, rtWidth: 100, rtHeight: 50 }]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const rtChain = [
      pass({ target: '_rt_FullCompoBuffer1', fboScale: { _rt_FullCompoBuffer1: 1 } }),
      pass({ bind: [{ index: 0, name: '_rt_FullCompoBuffer1' }, { index: 1, name: 'previous' }] }),
    ];
    stage.setObjectChains(1, [rtChain]);
    const entry = (stage as unknown as {
      entries: Map<number, { plan: { namedTargets: Array<{ key: string }> } | null }>;
    }).entries.get(1);
    expect(entry?.plan?.namedTargets.map((t) => t.key)).toEqual(['0:_rt_FullCompoBuffer1']);
    // 与线性链一致：所有链都挂载，不再有 rtGraphSkips()
    expect(typeof (stage as unknown as { rtGraphSkips?: unknown }).rtGraphSkips).toBe('undefined');
  });

  it('RT 图链的对象照常建 runner；链未有输出前 bindOutputs 不动输出（quad 保持对象 RT 原图）', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const rtChain = [pass({ target: '_rt_F' }), pass({ bind: [{ index: 0, name: '_rt_F' }] })];
    stage.setObjectChains(1, [rtChain]);
    expect(stage.debugRunners().size).toBe(1);
    stage.bindOutputs();                       // mock runner 的 lastOutput() 恒 null
    expect(host._outputs.has(1)).toBe(false);  // 未就绪 → 不切输出
  });

  it('setObjectChains 在对象尚无隔离条目时明确告警一次，且不建 runner（不暂存、不猜尺寸）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const host = createHost([]); // 隔离条目尚未出现＝调用顺序契约被破坏
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
    });
    stage.setObjectChains(7, [[pass()]]);
    stage.setObjectChains(7, [[pass()]]);
    // 去重告警：同一对象只打印一次（不再有「链先于条目 → 暂存」的死状态机）
    const warns = warn.mock.calls.filter((c) => String(c[0]).includes('尚无隔离条目'));
    expect(warns).toHaveLength(1);
    expect(stage.debugRunners().has(7)).toBe(false); // 绝不猜尺寸/静默建 runner
    // 线性链不是降级跳过：不再有 rtGraphSkips() 这套分类机制
    expect(typeof (stage as unknown as { rtGraphSkips?: unknown }).rtGraphSkips).toBe('undefined');
    warn.mockRestore();
  });

  it('bindOutputs：链未就绪（lastOutput 为 null）→ 不切输出；就绪 → 切到效果输出', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
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

  it('setAudioSpectrum：频谱源转发给每个 runner（缺省 null = 全零静音）', () => {
    const host = createHost([
      { id: 1, rtWidth: 10, rtHeight: 10 },
      { id: 2, rtWidth: 10, rtHeight: 10 },
    ]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const mk = () => ({
      setChains: vi.fn(), setAudioSpectrumSource: vi.fn(), dispose: vi.fn(),
      lastOutput: () => null, update: vi.fn(async () => null),
    });
    const r1 = mk();
    const r2 = mk();
    stage.debugInjectRunner(1, r1 as never);
    stage.debugInjectRunner(2, r2 as never);

    // 未注入频谱源（缺省）→ null（效果链保持全零，行为与改动前一致）
    stage.advance(1);
    expect(r1.setAudioSpectrumSource).toHaveBeenCalledWith(null);
    expect(r2.setAudioSpectrumSource).toHaveBeenCalledWith(null);

    // 注入后 → 每个 runner 都拿到**同一引用**（每帧刷新同一缓冲，避免逐 runner 拷贝）
    const spec = new Uint8Array(64).fill(7);
    stage.setAudioSpectrum(spec);
    stage.advance(2);
    expect(r1.setAudioSpectrumSource).toHaveBeenLastCalledWith(spec);
    expect(r2.setAudioSpectrumSource).toHaveBeenLastCalledWith(spec);
  });

  it('advance 串行：同一 runner 的第二次 update 在第一次完成后才发起', async () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
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
      wallpaperId: 'w', screenScale: 1,
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

  // ── Task 5（design §3.5）：效果链在**消费者段边界**拿到本帧快照 ──
  // player 在段边界同步通知（onSegmentBoundary），编排器记录该对象本帧的快照，同一帧的
  // advance 把它作为 frameTexture 传给 runner.update ⇒ `_rt_FullFrameBuffer` 拿到的是
  // 「该对象绘制之前」的本帧内容（不是上一帧），且 update 仍走同一把串行锁。
  it('段边界快照随本帧 advance 进入 runner（同帧，不落后一帧）', async () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    const snapshot = new THREE.Texture();
    stage.onSegmentBoundary(1, snapshot); // player 在消费者被绘制之前同步通知
    stage.advance(7);                     // 同一帧的 advance（快照立即被这一次 update 用掉）
    expect(runner.update).toHaveBeenCalledTimes(1);
    expect(runner.update.mock.calls[0][0]).toBe(7);
    expect(runner.update.mock.calls[0][1]).toBe(host.isolatedObjects()[0].rtTexture);
    expect(runner.update.mock.calls[0][2]).toBe(snapshot);
    // 下一帧没有边界通知 ⇒ 回到 null（快照逐帧覆盖，编排器不得跨帧持有）
    await new Promise((r) => setTimeout(r, 0)); // 让上一次 update settle（串行锁释放）
    stage.advance(8);
    expect(runner.update.mock.calls[1][2]).toBeNull();
  });

  it('同一帧对同一对象重复通知 → 仍只推进一次，最后一次边界的快照生效', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    const first = new THREE.Texture();
    const second = new THREE.Texture();
    stage.onSegmentBoundary(1, first);
    stage.onSegmentBoundary(1, second);
    stage.advance(1);
    expect(runner.update).toHaveBeenCalledTimes(1);
    expect(runner.update.mock.calls[0][2]).toBe(second);
  });

  it('边界通知可省纹理：编排器向 host.captureFullFrame() 拉取；宿主给 null ⇒ 该帧无快照', async () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const pulled = new THREE.Texture();
    let current: THREE.Texture | null = pulled;
    host.captureFullFrame = () => current;
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    stage.onSegmentBoundary(1); // 不带纹理：向宿主拉取
    stage.advance(1);
    expect(runner.update.mock.calls[0][2]).toBe(pulled);
    current = null;
    await new Promise((r) => setTimeout(r, 0)); // 串行锁释放后再推进下一帧
    stage.onSegmentBoundary(1);
    stage.advance(2);
    expect(runner.update.mock.calls[1][2]).toBeNull();
  });

  it('未挂链的对象收到边界通知 → 不建 runner、不推进（快照由 player 自己消费）', () => {
    const host = createHost([{ id: 9, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    expect(() => stage.onSegmentBoundary(9, new THREE.Texture())).not.toThrow();
    stage.advance(1);
    expect(stage.debugRunners().size).toBe(0);
    expect(host._outputs.size).toBe(0);
  });

  // resize 与异步 update 竞争：`FrameCapture.resize()` 会 dispose 旧快照并重建新实例
  //（FramebufferTexture 无 setSize），而快照此时可能已在串行队列里排队 —— 执行当刻再采它
  // 就是采一张已释放的纹理（该对象整块黑一帧）。判据 = **执行当刻**读实时快照代号（宿主提供）
  // 与捕获当刻记录的代号比较，不一致即按「无快照」走（null），而不是把旧引用传进 runner。
  it('resize 换代（实时代号变了）⇒ 排队中的 update 执行当刻按「无快照」走，不采已释放纹理', async () => {
    let live = 0; // 宿主（= player.frameSnapshotVersion()）读到的实时快照代号
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }], { frameSnapshotVersion: () => live });
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const resolvers: Array<() => void> = [];
    const frameTexArgs: unknown[] = [];
    const runner = {
      setChains: vi.fn(),
      setPlan: vi.fn(),
      setAudioSpectrumSource: vi.fn(),
      update: vi.fn((_t: number, _input: unknown, frameTex: unknown = null) => {
        frameTexArgs.push(frameTex);
        return new Promise<null>((resolve) => resolvers.push(() => resolve(null)));
      }),
      lastOutput: vi.fn(() => null),
      dispose: vi.fn(),
    };
    stage.debugInjectRunner(1, runner as never);
    const snapshotA = new THREE.Texture();
    stage.onSegmentBoundary(1, snapshotA, live); // 第一帧：捕获当刻代号 0
    stage.advance(1);                            // 第一帧的 update 在途（未 settle）
    expect(frameTexArgs).toEqual([snapshotA]);
    stage.onSegmentBoundary(1, snapshotA, live); // 第二帧仍用这一张（代号还是 0）
    stage.advance(2);                            // 排在队尾（第一帧未归）
    expect(runner.update).toHaveBeenCalledTimes(1);
    live = 1; // resize：FrameCapture 重建快照纹理（旧的那张已 dispose）⇒ 实时代号抬到 1
    stage.notifyViewportResize();
    resolvers[0](); // 第一帧 settle ⇒ 排队的第二帧开始执行
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.update).toHaveBeenCalledTimes(2);
    expect(runner.update.mock.calls[1][0]).toBe(2);
    expect(frameTexArgs[1]).toBeNull(); // 执行当刻代号不一致 ⇒ 不把已释放的快照传进链
  });

  // Minor 1：判据只能是「真的换代」。只是**排到下一帧**执行的 update 必须照常拿到快照
  //（旧实现按「段边界世代」比较，会把这类 runner 一并作废 —— 快照白丢一帧）。
  it('只是排到下一帧（实时代号未变）⇒ 快照照常传进链，不被误伤作废', async () => {
    let live = 0;
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }], { frameSnapshotVersion: () => live });
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const resolvers: Array<() => void> = [];
    const frameTexArgs: unknown[] = [];
    const runner = {
      setChains: vi.fn(),
      setPlan: vi.fn(),
      setAudioSpectrumSource: vi.fn(),
      update: vi.fn((_t: number, _input: unknown, frameTex: unknown = null) => {
        frameTexArgs.push(frameTex);
        return new Promise<null>((resolve) => resolvers.push(() => resolve(null)));
      }),
      lastOutput: vi.fn(() => null),
      dispose: vi.fn(),
    };
    stage.debugInjectRunner(1, runner as never);
    const snapshotA = new THREE.Texture();
    stage.onSegmentBoundary(1, snapshotA, live);
    stage.advance(1);                            // 在途
    stage.onSegmentBoundary(1, snapshotA, live); // 代号未变（没有 resize）
    stage.advance(2);                            // 排队
    resolvers[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(runner.update).toHaveBeenCalledTimes(2);
    expect(frameTexArgs[1]).toBe(snapshotA); // 落后一帧 ≠ 换代：快照不得被丢
    expect(live).toBe(0);
  });

  // `notifyViewportResize()` 的真实职责：作废**尚未被 advance 消费**的本帧快照
  //（已被 advance 带进闭包的那份由上面的实时代号比对兜底）。用例故意让宿主不提供代号，
  // 从而只剩这一条防线 —— 它必须真的起作用，不能是可省略的装饰。
  it('resize 落在「段边界通知」与「advance」之间 ⇒ 未消费的假快照被丢弃（不发进链）', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]); // 宿主不提供代号
    const stage = new ObjectEffectStage(host as never, { wallpaperId: 'w', screenScale: 1 });
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    stage.onSegmentBoundary(1, new THREE.Texture()); // 记号入表
    stage.notifyViewportResize();                    // resize 在 advance 之前落地（旧快照已 dispose）
    stage.advance(1);
    expect(runner.update.mock.calls[0][2]).toBeNull();
  });

  // ── Task 5：引用 `_rt_FullFrameBuffer` 的链必须把该对象登记为段边界消费者 ──
  // 不登记 ⇒ frameCapture 不 active ⇒ 段渲染不开启 ⇒ 段边界快照永不发生 ⇒ 快照恒为 null（白图）。
  // 惰性（design §3.2）：不引用的对象一律不登记，帧序与改动前逐字一致。
  it('引用整帧快照的链 → 登记为段边界消费者；不引用 / 被 bind 覆盖 → 不登记', () => {
    const host = createHost([
      { id: 1, rtWidth: 10, rtHeight: 10 },
      { id: 2, rtWidth: 10, rtHeight: 10 },
      { id: 3, rtWidth: 10, rtHeight: 10 },
    ]);
    const stage = new ObjectEffectStage(host as never, { wallpaperId: '2597392171', screenScale: 1 });
    stage.setObjectChains(1, [[pass()]]); // 普通链：不引用快照
    stage.setObjectChains(2, [[pass({ textureSlots: [null, '_rt_FullFrameBuffer'] })]]); // godrays_combine 形态
    stage.setObjectChains(3, [[pass({ // 该槽被 bind 覆盖 ⇒ 实际用的是 bind 的源，快照无意义
      textureSlots: [null, '_rt_FullFrameBuffer'],
      bind: [{ index: 1, name: 'previous' }],
    })]]);
    expect(host._frameConsumers).toEqual([2]);
    // 纯函数口径（与 EffectRunner.update 的槽绑定口径同源）
    expect(referencesFrameSnapshot([[pass({ textureSlots: [null, '_rt_FullFrameBuffer'] }) ]])).toBe(true);
    expect(referencesFrameSnapshot([[pass({ textureSlots: [null, '_rt_Bloom'] })]])).toBe(false);
    expect(referencesFrameSnapshot([
      [pass({ textureSlots: [null, '_rt_FullFrameBuffer'], bind: [{ index: 1, name: 'previous' }] })],
    ])).toBe(false);
    // 未解析名字的 bind 会被计划丢弃 ⇒ update 实际绑的仍是 `textureSlots[1]`（快照），故必须判 true。
    // 旧口径读原始 `pass.bind` ⇒ 同一 pass 判 false，与 update 分叉（本库 0 实例，靠这条钉住）。
    expect(referencesFrameSnapshot([
      [pass({ textureSlots: [null, '_rt_FullFrameBuffer'], bind: [{ index: 1, name: '_rt_NotDeclared' }] })],
    ])).toBe(true);
  });

  it('onViewportResize 按新屏幕密度等比重设 RT 尺寸（缩小→放大可逆；计划随新尺寸重建）', () => {
    const host = createHost([
      { id: 1, rtWidth: 100, rtHeight: 50 },
      { id: 2, rtWidth: 100, rtHeight: 50 }, // 无 entry：不能被反推世界尺寸
    ]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 2,
    });
    // 含具名 RT 的两 pass 链：计划里的 namedTargets 尺寸 = 对象 RT ÷ fboScale(1) ⇒ 随 resize 同比变。
    const chain = [
      pass({ target: '_rt_H' }),
      pass({ bind: [{ index: 0, name: '_rt_H' }] }),
    ];
    // 世界尺寸的**唯一来源**是 setWorldSize（此处 50×25，密度 2 ⇒ 首轮 RT 100×50）；
    // onViewportResize 只处理 entries 里已有条目的对象，故按契约顺序先挂链。
    stage.setWorldSize(1, 50, 25);
    stage.setObjectChains(1, [chain]);
    const runner = stage.debugRunners().get(1)!;
    const namedSize = (i: number) => {
      const plan = runner.setPlan.mock.calls[i][0];
      return [plan.namedTargets[0].width, plan.namedTargets[0].height];
    };
    expect(namedSize(0)).toEqual([100, 50]); // 挂载期：具名 RT 跟随对象 RT 100×50
    // 同一密度（2）→ 屏占位不变 → 不重设 RT（幂等）
    stage.onViewportResize(2);
    expect(host._resized).toEqual([]);
    // 密度 0.4（视口缩小）→ 屏占位 50×0.4=20 / 25×0.4=10 → 20×10
    stage.onViewportResize(0.4);
    // 只有 id 1 被重设：id 2 无 entry，直接跳过（不反推 rtWidth / 密度 当世界尺寸
    // ——那会把「已被 4096 上限收口的 RT」当世界尺寸，是不可逆的缩小）。
    expect(host._resized).toEqual([{ id: 1, w: 20, h: 10 }]);
    // 重挂（setChains 清空 last、旧 ping-pong RT 已 dispose）后必须显式回退对象 RT 原图，
    // 否则 quad 会在整个纹理重载窗口内采样已 dispose 的纹理。
    expect(host._outputs.get(1)).toBe(host.isolatedObjects().find((o) => o.id === 1)!.rtTexture);
    // 计划随新尺寸重建：具名 RT 100×50 → 20×10（同一份链、新基准）。
    expect(namedSize(1)).toEqual([20, 10]);
    // 放大回去：密度再回到 2 → 恢复 100×50（世界尺寸始终来自 setWorldSize，故可逆）
    stage.onViewportResize(2);
    expect(host._resized).toEqual([{ id: 1, w: 20, h: 10 }, { id: 1, w: 100, h: 50 }]);
    expect(namedSize(2)).toEqual([100, 50]);
    // 非法密度（0 / NaN）按 1 兜底，不产生 0/NaN 尺寸 RT
    stage.onViewportResize(0);
    expect(host._resized[2]).toEqual({ id: 1, w: 50, h: 25 });
  });

  // Task 6：resize 期与挂载期**同源**——两处都调 isolatedRtSize（同一纯函数、同一份输入）。
  // 旧实现在 resize 期另算一遍「屏占位」算术 ⇒ 任何一次 resize（哪怕密度完全没变）都会把已经
  // 升到 4096 的隔离 RT 打回屏占位，与全局约束「只升不降」冲突（本轮收口的中间态）。
  it('resize 期同源：已按源纹理收口 4096 的 RT，同密度 resize 后仍是 4096（不被打回屏占位）', () => {
    // 挂载期口径：世界 5000×2400、源纹理 5000×2400、密度 0.375 ⇒ 等比收口到 4096×1966
    // （屏占位只有 1875×900——正是旧口径 resize 后会给的值）。
    const host = createHost([{ id: 13, rtWidth: 4096, rtHeight: 1966 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 0.375,
    });
    stage.setWorldSize(13, 5000, 2400, { width: 5000, height: 2400 });
    stage.onViewportResize(0.375); // 同一密度：尺寸口径必须与挂载期逐字一致
    // 挂载期口径逐字钉住：屏占位 = 1875×900，源纹理收口到 4096 ⇒ 4096×1966（旧实现 resize 后
    // 会给 1875×900）。等价于「旧实现必须让 host._resized 出现一次 1875×900」。
    expect(isolatedRtSize(5000, 2400, 0.375, { width: 5000, height: 2400 }))
      .toEqual({ width: 4096, height: 1966, upgraded: true });
    // 尺寸与挂载期**恰好**相同 ⇒ 一次 resize 都不发生（比只断言「没发生 resize」更严：
    // 「先重设成 1875×900 再设回 4096×1966」这类往返也会让本断言变红）。
    expect(host._resized).toEqual([]);
    // 尺寸未变 ⇒ 不重挂链、不回退输出（entries 回写值同样是挂载期口径）。
    expect(host._outputs.size).toBe(0);
  });

  it('resize 期同源：屏占位状态下的隔离对象，resize 按源纹理升到 4096（不是屏占位）', () => {
    const host = createHost([{ id: 13, rtWidth: 1875, rtHeight: 900 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 0.375,
    });
    stage.setWorldSize(13, 5000, 2400, { width: 5000, height: 2400 });
    stage.onViewportResize(0.375);
    expect(host._resized).toEqual([{ id: 13, w: 4096, h: 1966 }]);
    // 再 resize 同一密度：已收口 ⇒ 幂等（尺寸未变就不重设 RT，也不重挂链/回退输出）
    stage.onViewportResize(0.375);
    expect(host._resized).toHaveLength(1);
  });

  it('resize 期只升不降：source 未知（null）→ 等于屏占位，且不小于屏占位', () => {
    const host = createHost([{ id: 13, rtWidth: 1, rtHeight: 1 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 0.375,
    });
    stage.setWorldSize(13, 5000, 2400, null); // 粒子对象/纹理未就绪一律传 null
    stage.onViewportResize(0.375);
    const last = host._resized.at(-1)!;
    expect([last.w, last.h]).toEqual([Math.round(5000 * 0.375), Math.round(2400 * 0.375)]);
    expect(last.w * last.h).toBeGreaterThanOrEqual(Math.round(5000 * 0.375) * Math.round(2400 * 0.375));
  });

  it('resize 期按**全部**条目重算预算：两个大源对象共享预算、按同一比例收窄', () => {
    const host = createHost([
      { id: 1, rtWidth: 1, rtHeight: 1 },
      { id: 2, rtWidth: 1, rtHeight: 1 },
    ]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 0.375,
    });
    const source = { width: 5000, height: 2400 };
    stage.setWorldSize(1, 5000, 2400, source); // 有 runner 的条目
    stage.setWorldSize(2, 5000, 2400, source); // 无 runner 的条目同样计入预算
    stage.onViewportResize(0.375);
    expect(host._resized.map((r) => [r.w, r.h])).toHaveLength(2);
    const [a, b] = host._resized;
    expect([a.w, a.h]).toEqual([b.w, b.h]); // 同一 budgetScale ⇒ 同尺寸
    // 钉实际收窄值（旧断言只钉不等式 <4096 / >1875，任何「收窄一点点」都能过）：两张 4096×1966
    // 合计 451 MB > 384 MB ⇒ budgetScale≈0.857947 ⇒ 3780×1814 = 383,987,520 B（3781×1815 = 384,300,840 B 装不下）。
    expect([a.w, a.h]).toEqual([3780, 1814]);
    expect(Math.max(a.w, a.h)).toBeLessThan(4096);
    expect(Math.max(a.w, a.h)).toBeGreaterThan(1875);
    expect((a.w * a.h + b.w * b.h) * ISOLATED_RT_BYTES_PER_PX).toBeLessThanOrEqual(ISOLATED_RT_BUDGET_BYTES);
  });

  it('dispose 释放全部 runner', () => {
    const host = createHost([{ id: 1, rtWidth: 10, rtHeight: 10 }]);
    const stage = new ObjectEffectStage(host as never, {
      wallpaperId: 'w', screenScale: 1,
    });
    const runner = createMockRunner();
    stage.debugInjectRunner(1, runner as never);
    stage.dispose();
    expect(runner.dispose).toHaveBeenCalled();
  });
});
