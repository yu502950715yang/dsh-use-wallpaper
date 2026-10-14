import { describe, expect, it } from 'vitest';
import { MDL_VERTEX_STRIDE, parseMdl } from '../src/client/mdl-parser.js';

// ── 夹具：在测试里构造最小合法 MDLV0021 + MDLS0004 + MDLA0006 ──────────────────
// 布局按上游 mdl-parse.js 的文档化段结构（本文件即「解析器 ↔ 夹具」的同一份口径）。
function buildMdlFixture(): Uint8Array {
  const vertices = new DataView(new ArrayBuffer(MDL_VERTEX_STRIDE * 3));
  for (let i = 0; i < 3; i++) {
    const o = i * MDL_VERTEX_STRIDE;
    vertices.setFloat32(o, i, true); vertices.setFloat32(o + 4, i * 2, true); vertices.setFloat32(o + 8, 0, true);
    for (let k = 0; k < 4; k++) vertices.setUint32(o + 40 + k * 4, i, true);          // boneIdx：三角各绑一根骨
    vertices.setFloat32(o + 56, 1, true);                                            // weights[0] = 1
    vertices.setFloat32(o + 72, i / 2, true); vertices.setFloat32(o + 76, 0.5, true); // uv
  }
  const indices = new Uint16Array([0, 1, 2]);

  const parts: number[] = [];
  const push = (bytes: number[]) => parts.push(...bytes);
  const pushStr = (s: string) => { for (const ch of s) parts.push(ch.charCodeAt(0)); parts.push(0); };
  const pushU32 = (v: number) => parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255);
  const pushI32 = (v: number) => pushU32(v >>> 0);
  const pushF32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); push([...b]); };

  pushStr('MDLV0021');                       // 0..8（8 字符 + 本应有 NUL，此处 9 字节由 pushStr 给出）
  // 头部：材质路径（零结尾）+ 32 字节偏移后的顶点字节数（MDLV0021 族）
  pushStr('materials/m.json');
  for (let i = 0; i < 32; i++) parts.push(0);
  pushU32(MDL_VERTEX_STRIDE * 3);
  push([...new Uint8Array(vertices.buffer)]);
  pushU32(indices.byteLength);
  push([...new Uint8Array(indices.buffer)]);

  // MDLS0004：magic(9) + u32 段尾 + u32 骨数；每骨 u8 flag + u32 id + i32 parent + u32 matSize + f32[16] + cstr json
  pushStr('MDLS0004');
  pushU32(0); pushU32(2);
  const bone = (id: number, parent: number, tx: number) => {
    push([0]); pushU32(id); pushI32(parent); pushU32(64);
    const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, 0, 0, 1]; // 列主序，平移在 [12..14]
    for (const v of m) pushF32(v);
    pushStr('{}');
  };
  bone(0, -1, 0); bone(1, 0, 5);

  // MDLA0006：magic(9) + u32 段尾 + u32 动画数
  pushStr('MDLA0006');
  pushU32(0); pushU32(1);
  pushU32(7); pushU32(0);                    // id=7 / unk
  pushStr('idle'); pushStr('loop');          // 名称 / 模式
  pushF32(30);                               // fps
  pushU32(2); pushU32(0); pushU32(1);        // frameCount / unk / trackCount
  for (let i = 0; i < 35; i++) parts.push(0); // 固定 35B 填充
  pushU32(1); pushU32(36 * 2);               // track：boneId=1 / trackBytes
  for (const tx of [5, 9]) {                 // 两帧：pos + 四元数 xyzw + scale xy
    pushF32(tx); pushF32(0); pushF32(0);
    pushF32(0); pushF32(0); pushF32(0); pushF32(1);
    pushF32(1); pushF32(1);
  }
  return new Uint8Array(parts);
}

describe('mdl-parser', () => {
  it('解析 MDLV 顶点（stride 80：pos/boneIdx@40/weights@56/uv@72）与索引', () => {
    const r = parseMdl(buildMdlFixture());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { mesh } = r.puppet;
    expect(mesh.vertexCount).toBe(3);
    expect([...mesh.indices]).toEqual([0, 1, 2]);
    expect([...mesh.positions.slice(0, 3)]).toEqual([0, 0, 0]);
    expect([...mesh.positions.slice(3, 6)]).toEqual([1, 2, 0]);
    expect([...mesh.uvs.slice(0, 2)]).toEqual([0, 0.5]);
    expect([...mesh.blendIndices!.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(mesh.blendWeights![0]).toBe(1);
    expect(mesh.materialPath).toBe('materials/m.json');
  });

  it('解析 MDLS 骨骼（父索引 + 列主序绑定矩阵平移）', () => {
    const r = parseMdl(buildMdlFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.bones).toHaveLength(2);
    expect(r.puppet.bones[0].parent).toBe(-1);
    expect(r.puppet.bones[1].parent).toBe(0);
    expect(r.puppet.bones[1].bind[12]).toBe(5); // 列主序平移 x
  });

  it('解析 MDLA 动画（id/名称/模式/fps/帧数/轨与 36B 关键帧）', () => {
    const r = parseMdl(buildMdlFixture());
    if (!r.ok) throw new Error(r.error);
    expect(r.puppet.animations).toHaveLength(1);
    const a = r.puppet.animations[0];
    expect([a.id, a.name, a.mode, a.fps, a.frameCount]).toEqual([7, 'idle', 'loop', 30, 2]);
    expect(a.tracks).toHaveLength(1);
    expect(a.tracks[0].boneId).toBe(1);
    expect(a.tracks[0].keys.map((k) => k.pos[0])).toEqual([5, 9]);
    expect(a.tracks[0].keys[1].rot).toEqual([0, 0, 0, 1]);
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
// 头 = magic(9) + u16 9 + u32 1 + u32 1 + u16 0（12B 二进制头 + 2B 对齐）⇒ 材质串 @21；
// 之后 7×u32 零 + u32 15（语义未确认，原样保留）+ u32 vertexBytes（实测 @53+4k 口径）；
// 顶点记录 stride 48：pos.xy @+0/+4、8 个常量 float @+8..+36、uv @+40/+44；随后 u32 索引字节数 + u16 索引。
const STATIC_STRIDE = 48;
const STATIC_VERTEX_COUNT = 10;
const STATIC_CONSTANTS = [0, 0, 0, 1, 1, 0, 0, 1]; // 实测在全部 1850 条记录上恒定（语义未知，不映射）

/** 静态族夹具（字段可覆写以构造畸形变体）：返回可直接喂 parseMdl 的字节流。 */
function buildStaticFixture(opts: { vertexBytes?: number; indexValues?: number[] } = {}): Uint8Array {
  const vertexBytes = opts.vertexBytes ?? STATIC_STRIDE * STATIC_VERTEX_COUNT;
  const indexValues = opts.indexValues ?? [0, 1, 2, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const material = 'materials/static.json';
  const verticesOffset = 21 + material.length + 1 + 7 * 4 + 4 + 4;
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
  });

  it('静态族 stride 判定：候选集 + 紧覆盖选出 48，诊断字段记下候选列表与各候选浪费率', () => {
    const r = parseMdl(buildStaticFixture());
    if (!r.ok) throw new Error(r.error);
    const info = r.puppet.mesh.strideInfo;
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
    const truncated = buildStaticFixture().slice(0, 79 + 200);
    expect(() => parseMdl(truncated)).not.toThrow();
    expect(parseMdl(truncated).ok).toBe(false);
    // 坏 magic
    const badMagic = buildStaticFixture();
    badMagic[0] = 0x58; // 'X'
    expect(parseMdl(badMagic).ok).toBe(false);
    // 索引越界：stride 48 下 maxIndex 11 ≥ 10 顶点；紧覆盖会指向 40（无字段布局）⇒ 拒收
    const outOfRange = parseMdl(buildStaticFixture({ indexValues: [0, 1, 11, 1, 2, 3, 4, 5, 6, 7, 8, 9] }));
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.error).toMatch(/^stride-/);
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
});
