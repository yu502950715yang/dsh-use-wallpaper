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
  it('pass 采样具名 RT（bind 非空）→ 非线性的 RT 图链', () => {
    expect(isLinearEffectChain([pass({ bind: [{ name: 'previous', index: 0 }] })])).toBe(false);
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
