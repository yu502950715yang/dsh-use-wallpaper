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
