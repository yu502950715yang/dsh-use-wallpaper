import { describe, expect, it, vi } from 'vitest';
import { MDL_VERTEX_STRIDE, parseMdl } from '../src/client/mdl-parser.js';

// ── 夹具：按真实素材实测布局构造最小合法 MDL ──────────────────────────────────
// 段布局（AGENT.md §7.40，3828798871 / 3812518176 两份真实样本 + we-layerd 参考实现）：
//   MDLS0004：9B stamp + u32 段尾 + u16 骨数 + u16 填充；每骨 = name cstr / i32（临时值，非骨 id）/
//             u32 父索引 / u32 绑矩阵字节数(64) / f32[16] 列主序 / 仿真 JSON cstr。
//   MDLA0006：9B stamp + u32 段尾 + u32 动画数；每动画 = id（跳过 0 填充）/ i32 / name / mode /
//             f32 fps / i32 长度 / i32 / u32 轨数；每轨 = i32（恒 0）/ u32 字节数 / 36B 关键帧；
//             轨后 mdla≥3 读 1B 分隔。
// 几何沿用旧式单网格：材质串 @21 + 32B 填充 + u32 顶点字节数 + 顶点 + u32 索引字节数 + 索引。
const FIXTURE_MATERIAL = 'materials/m.json';
/** 夹具顶点块起点（magic 9 + 材质串含 NUL + 32B 填充 + u32 顶点字节数），勿硬编码。 */
const FIXTURE_VERTICES_OFFSET = 9 + FIXTURE_MATERIAL.length + 1 + 32 + 4;

interface FixtureKey {
  pos: [number, number, number];
  angle: [number, number, number];
  scale: [number, number, number];
}

interface FixtureOptions {
  /** 骨记录（parent 为文件顺序下标；-1 = 根；tx = 绑矩阵平移 x） */
  bones?: Array<{ parent: number; tx: number }>;
  /** 每顶点第 0 槽的骨下标（默认 [0, 1, 1]） */
  vertexBoneIds?: [number, number, number];
  /** 每个动画的关键帧（默认 2 帧：位移 5→9、绕 z 转 0→90°） */
  keys?: FixtureKey[];
  /** 动画 id 列表（默认 [7]，每项各生成一个同形动画） */
  animationIds?: number[];
  /** 每个动画 id 前补的 0 字段数（真实导出器会补位；默认 0） */
  padBeforeId?: number;
  /** 轨字节数覆盖（畸形用） */
  trackBytes?: number;
  /** 骨记录的绑矩阵字节数覆盖（畸形用） */
  transformBytes?: number;
}

const DEFAULT_KEYS: FixtureKey[] = [
  { pos: [5, 0, 0], angle: [0, 0, 0], scale: [1, 1, 1] },
  { pos: [9, 0, 0], angle: [0, 0, Math.PI / 2], scale: [1, 1, 1] },
];

function buildMdlFixture(opts: FixtureOptions = {}): Uint8Array {
  const bones = opts.bones ?? [{ parent: -1, tx: 0 }, { parent: 0, tx: 5 }];
  const vertexBoneIds = opts.vertexBoneIds ?? [0, 1, 1];
  const keys = opts.keys ?? DEFAULT_KEYS;
  const animationIds = opts.animationIds ?? [7];
  const trackBytes = opts.trackBytes ?? 36 * keys.length;

  const parts: number[] = [];
  const push = (bytes: number[]) => parts.push(...bytes);
  const pushStr = (s: string) => { for (const ch of s) parts.push(ch.charCodeAt(0)); parts.push(0); };
  const pushU16 = (v: number) => parts.push(v & 255, (v >>> 8) & 255);
  const pushU32 = (v: number) => parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const pushI32 = (v: number) => pushU32(v >>> 0);
  const pushF32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); push([...b]); };
  /** 段头：先占位 u32 段尾，返回 patch 函数（段尾 = 段 payload 结束的绝对偏移）。 */
  const pushSectionHeader = (stamp: string): (() => void) => {
    pushStr(stamp);
    const endOffsetSlot = parts.length;
    pushU32(0);
    return () => {
      const end = parts.length;
      parts[endOffsetSlot] = end & 255;
      parts[endOffsetSlot + 1] = (end >>> 8) & 255;
      parts[endOffsetSlot + 2] = (end >>> 16) & 255;
      parts[endOffsetSlot + 3] = (end >>> 24) & 255;
    };
  };

  // ── 几何（旧式单网格；顶点 stride 80：pos/boneIdx@40/weights@56/uv@72）──
  const vertices = new DataView(new ArrayBuffer(MDL_VERTEX_STRIDE * 3));
  for (let i = 0; i < 3; i++) {
    const o = i * MDL_VERTEX_STRIDE;
    vertices.setFloat32(o, i, true);
    vertices.setFloat32(o + 4, i * 2, true);
    vertices.setFloat32(o + 8, 0, true);
    vertices.setUint32(o + 40, vertexBoneIds[i], true); // 第 0 槽绑骨下标；其余槽 id=0 且权重 0
    vertices.setFloat32(o + 56, 1, true);              // 权重和 = 1
    vertices.setFloat32(o + 72, i / 2, true);
    vertices.setFloat32(o + 76, 0.5, true);
  }
  const indices = new Uint16Array([0, 1, 2]);

  pushStr('MDLV0023');
  pushStr(FIXTURE_MATERIAL);
  for (let i = 0; i < 32; i++) parts.push(0);
  pushU32(MDL_VERTEX_STRIDE * 3);
  push([...new Uint8Array(vertices.buffer)]);
  pushU32(indices.byteLength);
  push([...new Uint8Array(indices.buffer)]);

  // ── MDLS0004 ──
  const patchMdls = pushSectionHeader('MDLS0004');
  pushU16(bones.length);
  pushU16(0); // 填充
  for (const bone of bones) {
    push([0]); // 空名 cstr（真实素材骨骼名均为空）
    pushI32(1); // 临时值（真实素材恒 1，不是骨 id）
    pushI32(bone.parent);
    pushU32(opts.transformBytes ?? 64);
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, bone.tx, 0, 0, 1]; // 列主序，平移在 [12..14]
    for (const v of m) pushF32(v);
    pushStr('{}');
  }
  patchMdls();

  // ── MDLA0006 ──
  const patchMdla = pushSectionHeader('MDLA0006');
  pushU32(animationIds.length);
  for (const id of animationIds) {
    for (let i = 0; i < (opts.padBeforeId ?? 0); i++) pushU32(0);
    pushU32(id);
    pushU32(0);              // 未知字段
    pushStr('idle');
    pushStr('loop');
    pushF32(30);             // fps
    pushU32(keys.length);    // 动画长度（帧数）
    pushU32(0);              // 未知字段
    pushU32(1);              // 轨数
    pushI32(0);              // 轨头 i32（真实素材恒 0，不是骨 id）
    pushU32(trackBytes);
    for (const key of keys) {
      pushF32(key.pos[0]); pushF32(key.pos[1]); pushF32(key.pos[2]);
      pushF32(key.angle[0]); pushF32(key.angle[1]); pushF32(key.angle[2]);
      pushF32(key.scale[0]); pushF32(key.scale[1]); pushF32(key.scale[2]);
    }
    push([0]); // MDLA ≥ 3 的轨后 35B 全零尾块（实测 6/6 动画；多动画必须整块跳过）
    for (let i = 1; i < 35; i++) push([0]);
  }
  patchMdla();
  return new Uint8Array(parts);
}

/** 段标记在夹具里的偏移（头部长度会随字段调整，勿硬编码）。 */
function markerAt(buf: Uint8Array, marker: string): number {
  outer: for (let i = 0; i + marker.length <= buf.length; i++) {
    for (let k = 0; k < marker.length; k++) if (buf[i + k] !== marker.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

describe('mdl-parser', () => {
  it('解析 MDLV 顶点（stride 80：pos/boneIdx@40/weights@56/uv@72）与索引', () => {
    const r = parseMdl(buildMdlFixture());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { mesh } = r.puppet;
    expect(mesh.vertexCount).toBe(3);
    expect([...mesh.indices]).toEqual([0, 1, 2]);
    expect([...mesh.positions.slice(0, 6)]).toEqual([0, 0, 0, 1, 2, 0]);
    expect([...mesh.uvs.slice(0, 2)]).toEqual([0, 0.5]);
    // 蒙皮槽 = 骨表下标：第 0 槽原样带出（不做文件 id 重映射）
    expect([...mesh.blendIndices!.filter((_, i) => i % 4 === 0)]).toEqual([0, 1, 1]);
    expect(mesh.blendWeights![0]).toBe(1);
    expect(mesh.materialPath).toBe(FIXTURE_MATERIAL);
  });

  it('解析 MDLS0004 骨骼：骨数 u16 + 父索引 + 列主序绑矩阵平移（下标 = 文件记录顺序）', () => {
    const r = parseMdl(buildMdlFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.bones).toHaveLength(2);
    expect(r.puppet.bones.map((b) => b.index)).toEqual([0, 1]);
    expect(r.puppet.bones[0].parent).toBe(-1);
    expect(r.puppet.bones[1].parent).toBe(0);
    expect(r.puppet.bones[1].bind[12]).toBe(5); // 列主序平移 x
  });

  it('解析 MDLA0006 动画：id/名称/模式/fps/长度/轨数 + 36B 关键帧（pos/欧拉角/scale 三分量）', () => {
    const r = parseMdl(buildMdlFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.animations).toHaveLength(1);
    const a = r.puppet.animations[0];
    expect([a.id, a.name, a.mode, a.fps, a.frameCount]).toEqual([7, 'idle', 'loop', 30, 2]);
    expect(a.tracks).toHaveLength(1);
    const track = a.tracks[0];
    expect(track.authored).toBe(true);
    expect(track.keys.map((k) => k.pos[0])).toEqual([5, 9]);
    // 欧拉角按作者值带出（弧度）；scale 三分量
    expect(track.keys[1].angle[2]).toBeCloseTo(Math.PI / 2, 6);
    expect(track.keys[0].scale).toEqual([1, 1, 1]);
  });

  it('轨的 boneId = 轨序（轨头 i32 恒 0，不是骨 id；顶点蒙皮也按下标绑）', () => {
    const r = parseMdl(buildMdlFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.animations[0].tracks[0].boneId).toBe(0);
    expect(r.puppet.mesh.blendIndices![4]).toBe(1); // 顶点 1 第 0 槽 → bones[1]
  });

  it('多动画 + 每动画轨后 35B 尾块：后续动画不错位（真实 leon 样本 4 动画的形态）', () => {
    const r = parseMdl(buildMdlFixture({ animationIds: [7, 9, 11] }));
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.animations.map((a) => a.id)).toEqual([7, 9, 11]);
    expect(r.puppet.animations.every((a) => a.tracks.length === 1)).toBe(true);
    expect(r.puppet.segments).toEqual({ mdls: 'ok', mdla: 'ok' });
  });

  it('动画 id 前的 0 填充字段被跳过（导出器补位）', () => {
    const r = parseMdl(buildMdlFixture({ animationIds: [7], padBeforeId: 2 }));
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.animations.map((a) => a.id)).toEqual([7]);
  });

  it('父索引乱序（指向后面的骨）⇒ 按根处理，不建出成环的骨骼树', () => {
    const r = parseMdl(buildMdlFixture({ bones: [{ parent: 1, tx: 0 }, { parent: -1, tx: 5 }] }));
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.bones[0].parent).toBe(-1);
    expect(r.puppet.bones[1].parent).toBe(-1);
  });

  it('畸形输入返回结构化错误，绝不抛（含空 buffer / 坏 magic / 截断）', () => {
    expect(parseMdl(new Uint8Array(0)).ok).toBe(false);
    expect(parseMdl(new Uint8Array(16)).ok).toBe(false);
    const bad = buildMdlFixture(); bad[0] = 0x58; // 'X'
    const r = parseMdl(bad);
    expect(r.ok).toBe(false);
    expect(parseMdl(buildMdlFixture().slice(0, 60)).ok).toBe(false);
  });

  it('版本白名单：MDLV0013/0016/0017/0019/0021/0023 之外拒收', () => {
    const buf = buildMdlFixture();
    const ascii = (v: string) => { for (let i = 0; i < 8; i++) buf[i] = v.charCodeAt(i); };
    ascii('MDLV0002');
    expect(parseMdl(buf).ok).toBe(false);
    ascii('MDLV0023');
    expect(parseMdl(buf).ok).toBe(true);
  });
});

// ── 静态族夹具（本机实测口径）：无 MDLS/MDLA/MDLE 段标记 + 顶点块 stride 48 ─────────────
// 段头/字段偏移等实测口径见 AGENT.md §7.40，此处不复制；uv@+40/+44、pos.xy@+0/+4。
const STATIC_STRIDE = 48;
const STATIC_VERTEX_COUNT = 10;
const STATIC_MATERIAL = 'materials/static.json';
/** 静态族夹具的 8 个 float @+8..+36：**只代表本夹具**（真实样本的 +28 每顶点都不同，见 AGENT.md §7.40）。 */
const STATIC_CONSTANTS = [0, 0, 0, 1, 1, 0, 0, 1];

/** 静态族夹具里顶点块起点（材质串 @21 + 7×u32 零 + u32 15 + u32 vertexBytes），勿硬编码。 */
function staticVerticesOffset(): number { return 21 + STATIC_MATERIAL.length + 1 + 7 * 4 + 4 + 4; }

/** 静态族夹具（字段可覆写以构造畸形变体）：返回可直接喂 parseMdl 的字节流。 */
function buildStaticFixture(opts: { vertexBytes?: number; indexValues?: number[] } = {}): Uint8Array {
  const vertexBytes = opts.vertexBytes ?? STATIC_STRIDE * STATIC_VERTEX_COUNT;
  const indexValues = opts.indexValues ?? [0, 1, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const material = STATIC_MATERIAL;
  const verticesOffset = staticVerticesOffset();
  const indexLenOffset = verticesOffset + vertexBytes;
  const buf = new Uint8Array(indexLenOffset + 4 + indexValues.length * 2);
  const dv = new DataView(buf.buffer);
  const ascii = (s: string, at: number) => { for (let i = 0; i < s.length; i++) buf[at + i] = s.charCodeAt(i); };
  ascii('MDLV0021', 0);
  dv.setUint16(9, 9, true);
  dv.setUint32(11, 1, true);
  dv.setUint32(15, 1, true);
  ascii(material, 21); // 结束 NUL 落在下一字节（默认 0）
  dv.setUint32(verticesOffset - 8, 15, true);
  dv.setUint32(verticesOffset - 4, vertexBytes, true);
  for (let i = 0; i < Math.floor(vertexBytes / STATIC_STRIDE); i++) {
    const o = verticesOffset + i * STATIC_STRIDE;
    dv.setFloat32(o, i, true); dv.setFloat32(o + 4, i * 2, true);
    for (let k = 0; k < STATIC_CONSTANTS.length; k++) dv.setFloat32(o + 8 + k * 4, STATIC_CONSTANTS[k], true);
    dv.setFloat32(o + 40, i / 4, true); dv.setFloat32(o + 44, 0.25, true);
  }
  dv.setUint32(indexLenOffset, indexValues.length * 2, true);
  for (let i = 0; i < indexValues.length; i++) dv.setUint16(indexLenOffset + 4 + i * 2, indexValues[i], true);
  return buf;
}

describe('mdl-parser · 静态族（无段标记 + stride 候选集择一）', () => {
  it('静态族夹具：无 MDLS/MDLA ⇒ bones/animations 为空、blendWeights=null，几何按 stride 48 解码', () => {
    const r = parseMdl(buildStaticFixture());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { mesh } = r.puppet;
    expect(mesh.vertexCount).toBe(STATIC_VERTEX_COUNT);
    expect([...mesh.positions.slice(0, 6)]).toEqual([0, 0, 0, 1, 2, 0]);
    expect([...mesh.uvs.slice(0, 4)]).toEqual([0, 0.25, 0.25, 0.25]);
    expect([...mesh.indices]).toEqual([0, 1, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(mesh.blendIndices).toBeNull();
    expect(mesh.blendWeights).toBeNull();
    expect(mesh.materialPath).toBe('materials/static.json');
    expect(r.puppet.bones).toEqual([]);
    expect(r.puppet.animations).toEqual([]);
    expect(r.puppet.segments).toEqual({ mdls: 'absent', mdla: 'absent' });
  });

  it('静态族 stride 判定：候选集 + 紧覆盖选出 48，诊断字段记下候选列表与各候选浪费率', () => {
    const r = parseMdl(buildStaticFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.mesh.strideInfo).toBeDefined(); // 可选字段（接口加法）：成功路径必填
    const info = r.puppet.mesh.strideInfo!;
    expect(info.stride).toBe(48);
    expect(info.reason).toBe('tight-coverage');
    expect(info.maxIndex).toBe(9);
    expect(info.candidates.map((c) => c.stride)).toEqual([24, 28, 32, 36, 40, 44, 48, 52, 56, 64, 72, 80]);
    const by = new Map(info.candidates.map((c) => [c.stride, c]));
    expect(by.get(48)!.waste).toBe(0);                 // 紧覆盖：1850 ≈ maxIndex+1
    expect(by.get(40)!.waste).toBeCloseTo(1 - 10 / 12, 6);
    expect(by.get(80)!.inRange).toBe(false);           // 6 顶点 < maxIndex 9 ⇒ 越界
    expect(by.get(28)!.divides).toBe(false);
    // 其余能容纳全部索引的候选浪费率都 > 5% ⇒ 48 是唯一紧覆盖者
    for (const c of info.candidates) if (c.inRange && c.stride !== 48) expect(c.waste).toBeGreaterThan(0.05);
  });

  it('静态族畸形变体：截断 / 坏 magic / 索引越界 / vertexBytes 不整除任何候选 ⇒ 各 {ok:false} 且不抛', () => {
    // 截断（顶点块中途切断）
    const truncated = buildStaticFixture().slice(0, staticVerticesOffset() + 200);
    expect(() => parseMdl(truncated)).not.toThrow();
    expect(parseMdl(truncated).ok).toBe(false);
    // 坏 magic
    const badMagic = buildStaticFixture();
    badMagic[0] = 0x58; // 'X'
    expect(parseMdl(badMagic).ok).toBe(false);
    // 索引越界：stride 48 下 maxIndex 11 ≥ 10 顶点；紧覆盖会指向 40（无字段布局）⇒ 拒收并留痕
    const outOfRange = parseMdl(buildStaticFixture({ indexValues: [0, 1, 11, 1, 2, 3, 4, 5, 6, 7, 8, 9] }));
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) {
      expect(outOfRange.error).toMatch(/^stride-/);
      expect(outOfRange.strideInfo?.stride).toBe(40);
      expect(outOfRange.strideInfo?.reason).toBe('layout-unknown');
    }
    // vertexBytes 不整除候选集里任何成员（481 = 13 × 37，候选全是偶数）
    expect(parseMdl(buildStaticFixture({ vertexBytes: 481 })).ok).toBe(false);
  });

  it('stride 判定不猜：最小浪费率 >5% 时返回结构化错误与诊断，不落网格', () => {
    const r = parseMdl(buildStaticFixture({ vertexBytes: 432, indexValues: [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/^stride-waste:/);
    // 诊断要说清「本会选中谁、为什么不要」：432B 下唯一最紧的是 72（6 顶点，浪费 50%）
    expect(r.strideInfo?.stride).toBe(72);
    expect(r.strideInfo?.reason).toBe('waste-too-high');
    expect(r.strideInfo?.maxIndex).toBe(2);
    expect(r.strideInfo?.candidates).toHaveLength(12);
  });

  it('紧覆盖 5% 边界：4.76% 收、正好 5% 拒（IEEE754 下 1−19/20 = 0.05000000000000004 > 0.05）', () => {
    // 整数组合里唯一落在 5% 附近的是 vc=20/21：更大候选（56/72）装不下 maxIndex ⇒ 48 就是最小浪费率。
    const under = parseMdl(buildStaticFixture({ vertexBytes: 48 * 21, indexValues: [0, 1, 19, 1, 2, 3] }));
    expect(under.ok).toBe(true);
    if (!under.ok) return;
    expect(under.puppet.mesh.strideInfo!.stride).toBe(48);
    expect(under.puppet.mesh.strideInfo!.reason).toBe('tight-coverage');
    expect(under.puppet.mesh.strideInfo!.candidates.find((c) => c.stride === 48)!.waste).toBeCloseTo(1 - 20 / 21, 12);

    const at = parseMdl(buildStaticFixture({ vertexBytes: 48 * 20, indexValues: [0, 1, 18] }));
    expect(at.ok).toBe(false);
    if (at.ok) return;
    expect(at.error).toMatch(/^stride-waste:/);
    expect(at.strideInfo?.stride).toBe(48);
    expect(at.strideInfo?.reason).toBe('waste-too-high');
    // 判据是「最小浪费率 > 0.05」：数学上正好 5% 的组合因浮点略超也被拒 ⇒ 实际收的是「< 5%」。
    expect(at.strideInfo!.candidates.find((c) => c.stride === 48)!.waste).toBeGreaterThan(0.05);
  });
});

// ── 蒙皮族细节 + 段级诊断（真实素材口径，见 AGENT.md §7.40） ─────────────────────────
describe('mdl-parser · 蒙皮族细节与段级诊断', () => {
  it('packed 族锚点命中：strideInfo 记为 packed-80，材质串取文档化 @9', () => {
    const r = parseMdl(buildMdlFixture());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.puppet.mesh.strideInfo).toBeDefined();
    expect(r.puppet.mesh.strideInfo!.stride).toBe(MDL_VERTEX_STRIDE);
    expect(r.puppet.mesh.strideInfo!.reason).toBe('packed-80');
    expect(r.puppet.mesh.materialPath).toBe(FIXTURE_MATERIAL);
  });

  it('权重和 ≠ 1 ⇒ blendIndices/blendWeights 置 null（几何仍解出，不把垃圾权重交给蒙皮）', () => {
    const buf = buildMdlFixture();
    new DataView(buf.buffer).setFloat32(FIXTURE_VERTICES_OFFSET + 56, 0.5, true); // weights[0] 1 → 0.5（和 0.5）
    const r = parseMdl(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.puppet.mesh.blendIndices).toBeNull();
    expect(r.puppet.mesh.blendWeights).toBeNull();
    expect(r.puppet.mesh.vertexCount).toBe(3);
  });

  it('扫描命中时材质串取以 .json 结尾的宽口径，不退化成 @21 的后缀（如 m.json）', () => {
    // 在材质串 NUL 之后补 8 B 零：文档化锚点（+32/+36 填充）读到 0 落空，只能靠扫描命中
    const base = buildMdlFixture();
    const at = 9 + FIXTURE_MATERIAL.length + 1;
    const buf = new Uint8Array(base.length + 8);
    buf.set(base.subarray(0, at));
    buf.set(base.subarray(at), at + 8);
    const r = parseMdl(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.puppet.mesh.materialPath).toBe(FIXTURE_MATERIAL);
    expect(r.puppet.mesh.strideInfo!.stride).toBe(MDL_VERTEX_STRIDE);
  });

  it('两段都在且解析完整 ⇒ segments 全 ok', () => {
    const r = parseMdl(buildMdlFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.segments).toEqual({ mdls: 'ok', mdla: 'ok' });
  });

  it('MDLS 在但骨记录不完整（绑矩阵字节数 ≠ 64）⇒ mdls=failed、bones=[]，mdla 仍 ok', () => {
    const buf = buildMdlFixture({ transformBytes: 60 });
    const r = parseMdl(buf);
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.bones).toEqual([]);
    expect(r.puppet.segments).toEqual({ mdls: 'failed', mdla: 'ok' });
  });

  it('MDLA 在但轨字节数非 36 倍数 ⇒ mdla=failed、animations=[]（不被静默当成「无动画」）', () => {
    const r = parseMdl(buildMdlFixture({ trackBytes: 70 }));
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.animations).toEqual([]);
    expect(r.puppet.segments).toEqual({ mdls: 'ok', mdla: 'failed' });
  });

  it('全零/绑定姿态轨 ⇒ authored=false（WE 语义：保持绑定姿态，不当成动画姿态）', () => {
    const r = parseMdl(buildMdlFixture({
      keys: [
        { pos: [0, 0, 0], angle: [0, 0, 0], scale: [1, 1, 1] },
        { pos: [0, 0, 0], angle: [0, 0, 0], scale: [1, 1, 1] },
      ],
    }));
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.animations[0].tracks[0].authored).toBe(false);
  });
});

describe('mdl-parser · 蒙皮槽与骨下标同口径', () => {
  it('blendIndices 原样带出（不做文件 id 重映射；骨下标 = 文件记录顺序）', () => {
    const r = parseMdl(buildMdlFixture({ vertexBoneIds: [0, 1, 1] }));
    if (!r.ok) throw new Error(r.error);
    expect([...r.puppet.mesh.blendIndices!.filter((_, i) => i % 4 === 0)]).toEqual([0, 1, 1]);
    // 判别性：逐顶点用 skinIndex 查 bones[]，取到的骨正是顶点绑的那根（bind 平移 0/5）
    const idx = r.puppet.mesh.blendIndices!;
    expect([0, 1, 2].map((v) => r.puppet.bones[idx[v * 4]].bind[12])).toEqual([0, 5, 5]);
  });

  it('有权重槽引用越界骨下标 ⇒ 整份蒙皮退化静态网格并告警**一次**', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = parseMdl(buildMdlFixture({ vertexBoneIds: [0, 5, 1] })); // 5 不是合法骨下标
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.mesh.blendIndices).toBeNull();
    expect(r.puppet.mesh.blendWeights).toBeNull();
    const degraded = warn.mock.calls.filter((c) => String(c[0]).includes('退化为静态网格'));
    expect(degraded).toHaveLength(1);
    expect(String(degraded[0][0])).toContain('5');
    warn.mockRestore();
  });

  it('零权重槽是骨表里没有的垃圾下标 ⇒ 蒙皮仍成立（只判有权重的槽），不告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const buf = buildMdlFixture({ vertexBoneIds: [0, 1, 1] });
    // 顶点 1 的其它 3 个槽：id=12345、权重 0（不参与蒙皮）
    const dv = new DataView(buf.buffer);
    for (let k = 1; k < 4; k++) dv.setUint32(FIXTURE_VERTICES_OFFSET + MDL_VERTEX_STRIDE + 40 + k * 4, 12345, true);
    const r = parseMdl(buf);
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.mesh.blendIndices).not.toBeNull();
    expect(warn.mock.calls.some((c) => String(c[0]).includes('退化为静态网格'))).toBe(false);
    warn.mockRestore();
  });

  it('无 MDLS 但顶点带蒙皮槽 ⇒ 无法蒙皮，退化为静态网格（几何仍解出）', () => {
    const full = buildMdlFixture();
    const mdlsAt = markerAt(full, 'MDLS');
    // 把 MDLS 段头改成非法（段尾越界）⇒ 按「无骨表」处理；同时把它的标记文本抹掉避免 failed 诊断
    const buf = new Uint8Array(full.subarray(0, mdlsAt));
    const r = parseMdl(buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.puppet.bones).toEqual([]);
    expect(r.puppet.mesh.blendIndices).toBeNull();
    expect(r.puppet.segments!.mdls).toBe('absent');
  });
});
