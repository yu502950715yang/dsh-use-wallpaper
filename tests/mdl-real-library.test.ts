import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMdl } from '../src/client/mdl-parser.js';

// 真实 puppet 样本（本机库；CI 上无素材 ⇒ 跳过）：
// ① 静态族：死亡搁浅-玛玛（pkg 内 models/20240220213723_1_puppet.mdl，无 MDLS/MDLA）。
// ② 蒙皮 + 动画：影之刃零1 的两个人物（MDLV0023 / MDLS0004 / MDLA0006 / MDLE0002）。
//    这是「桌面有动画、dsh 无动画」的原始 bug 素材，硬断言到骨表/动画/蒙皮槽。
const SAMPLES = {
  staticImage: 'D:/Steam/steamapps/workshop/content/431960/3303428996/scene.pkg',
  renwu: 'D:/Steam/steamapps/workshop/content/431960/3828798871/scene.pkg',
  leon: 'D:/Steam/steamapps/workshop/content/431960/3812518176/scene.pkg',
} as const;

function readEntry(pkg: Buffer, want: (name: string) => boolean): Uint8Array | null {
  let pos = 16, dataStart = 0;
  const entries: Array<{ name: string; off: number; size: number }> = [];
  while (pos + 4 <= pkg.length) {
    const n = pkg.readUInt32LE(pos);
    if (n <= 0 || n > 1024) { dataStart = pos; break; }
    entries.push({ name: pkg.toString('utf8', pos + 4, pos + 4 + n), off: pkg.readUInt32LE(pos + 4 + n), size: pkg.readUInt32LE(pos + 8 + n) });
    pos += 4 + n + 8;
  }
  const e = entries.find((x) => want(x.name));
  return e ? new Uint8Array(pkg.subarray(dataStart + e.off, dataStart + e.off + e.size)) : null;
}

function loadPuppet(pkgPath: string, entryName: string) {
  const pkg = readFileSync(pkgPath);
  const bytes = readEntry(pkg, (n) => n === entryName);
  expect(bytes, `pkg 内应有 ${entryName}`).not.toBeNull();
  const r = parseMdl(bytes as Uint8Array);
  expect(r.ok, r.ok ? '' : (r as { error: string }).error).toBe(true);
  if (!r.ok) throw new Error(r.error);
  return r.puppet;
}

if (!existsSync(SAMPLES.staticImage)) {
  console.warn(`[mdl-real-library] 未找到样本 ${SAMPLES.staticImage} —— 真实 puppet 冒烟本次跳过（CI 上属预期）`);
}
if (!existsSync(SAMPLES.renwu)) {
  console.warn(`[mdl-real-library] 未找到样本 ${SAMPLES.renwu} —— 蒙皮动画样本本次跳过（CI 上属预期）`);
}
if (!existsSync(SAMPLES.leon)) {
  console.warn(`[mdl-real-library] 未找到样本 ${SAMPLES.leon} —— 多动画样本本次跳过（CI 上属预期）`);
}

describe.skipIf(!existsSync(SAMPLES.staticImage))('真实 puppet 样本 · 静态族（本机库）', () => {
  it('解析出门 3303428996 的 MDL（几何必成功；骨骼/蒙皮/动画数列入日志不作断言）', () => {
    const puppet = loadPuppet(SAMPLES.staticImage, 'models/20240220213723_1_puppet.mdl');
    // 硬判据：只有「解析器落到正确段」才能成立的部分（顶点数 + 索引全部在范围内）
    expect(puppet.mesh.vertexCount).toBeGreaterThan(0);
    for (const v of puppet.mesh.indices) expect(v).toBeLessThan(puppet.mesh.vertexCount);
    expect(puppet.mesh.materialPath.endsWith('.json')).toBe(true);
    // 该样本实测**没有** MDLS/MDLA/MDLE 段（详见 AGENT.md §7.40）⇒ 只记录不断言骨数。
    // 但「段不存在」是硬事实：段级诊断必须为 absent，否则解析失败会被当成「无动画」。
    expect(puppet.segments).toEqual({ mdls: 'absent', mdla: 'absent' });
    const info = puppet.mesh.strideInfo!; // 成功路径必填（接口上是可选字段）
    console.log(`[mdl] static: version=${puppet.version} stride=${info.stride} verts=${puppet.mesh.vertexCount} indices=${puppet.mesh.indices.length} bones=${puppet.bones.length} anims=${puppet.animations.length} segments=${puppet.segments!.mdls}/${puppet.segments!.mdla}`);
  });
});

describe.skipIf(!existsSync(SAMPLES.renwu))('真实 puppet 样本 · 影之刃零1 蒙皮动画（本机库）', () => {
  it('renwu 1：5 骨（父子 -1/0/0/0/3）+ 蒙皮槽 + 动画 80（360 帧 / 60fps / 5 轨）', () => {
    const puppet = loadPuppet(SAMPLES.renwu, 'models/renwu 1_puppet.mdl');
    expect(puppet.mesh.vertexCount).toBe(1209);
    for (const v of puppet.mesh.indices) expect(v).toBeLessThan(puppet.mesh.vertexCount);
    expect(puppet.mesh.materialPath).toBe('materials/renwu 1.json');
    expect(puppet.segments).toEqual({ mdls: 'ok', mdla: 'ok' });
    expect(puppet.bones).toHaveLength(5);
    expect(puppet.bones.map((b) => b.parent)).toEqual([-1, 0, 0, 0, 3]);
    // 蒙皮槽 = 骨下标，必须保住（旧实现把骨记录里的临时值当文件 id 重映射 ⇒ 整份蒙皮被丢弃）
    expect(puppet.mesh.blendIndices).not.toBeNull();
    expect(puppet.mesh.blendWeights).not.toBeNull();
    expect(puppet.mesh.blendIndices!.length).toBe(1209 * 4);
    expect(puppet.animations).toHaveLength(1);
    const anim = puppet.animations[0];
    expect([anim.id, anim.mode, anim.fps, anim.frameCount]).toEqual([80, 'loop', 60, 360]);
    expect(anim.name).toBe('动画 1'); // 名称是 UTF-8（中文），按 UTF-8 解码而不是逐字节转 char
    expect(anim.tracks).toHaveLength(5);
    expect(anim.tracks.map((t) => t.boneId)).toEqual([0, 1, 2, 3, 4]);
    // 关键帧是绝对局部变换：轨 0 的第 0 帧位置 == 骨 0 的 bind 平移（真实素材交叉校验）
    const k0 = anim.tracks[0].keys[0];
    expect(k0.pos[0]).toBeCloseTo(puppet.bones[0].bind[12], 2);
    expect(k0.pos[1]).toBeCloseTo(puppet.bones[0].bind[13], 2);
    // 有作者姿态的轨必须被识别出来（否则渲染侧按 WE 语义会保持绑定姿态 = 仍不动）
    expect(anim.tracks.filter((t) => t.authored).length).toBeGreaterThan(0);
    console.log(`[mdl] renwu1: bones=${puppet.bones.length} anims=${puppet.animations.map((a) => `${a.id}/${a.frameCount}f/${a.fps}fps/${a.tracks.length}tracks`).join(',')} verts=${puppet.mesh.vertexCount} skinned=${puppet.mesh.blendIndices !== null}`);
  });

  it('renwu 2：5 骨（父 -1/0/0/0/0）+ 动画 104（360 帧 / 60fps）', () => {
    const puppet = loadPuppet(SAMPLES.renwu, 'models/renwu 2_puppet.mdl');
    expect(puppet.mesh.vertexCount).toBe(509);
    expect(puppet.segments).toEqual({ mdls: 'ok', mdla: 'ok' });
    expect(puppet.bones.map((b) => b.parent)).toEqual([-1, 0, 0, 0, 0]);
    expect(puppet.mesh.blendIndices).not.toBeNull();
    expect(puppet.animations).toHaveLength(1);
    const anim = puppet.animations[0];
    expect([anim.id, anim.mode, anim.fps, anim.frameCount]).toEqual([104, 'loop', 60, 360]);
    expect(anim.tracks).toHaveLength(5);
    console.log(`[mdl] renwu2: bones=${puppet.bones.length} anims=${puppet.animations.map((a) => `${a.id}/${a.frameCount}f/${a.fps}fps/${a.tracks.length}tracks`).join(',')} verts=${puppet.mesh.vertexCount} skinned=${puppet.mesh.blendIndices !== null}`);
  });
});

describe.skipIf(!existsSync(SAMPLES.leon))('真实 puppet 样本 · leon 多动画（本机库）', () => {
  it('MDLA 4 个动画不错位（每动画轨后 35B 尾块必须整块跳过），13 骨父子链全解出', () => {
    const puppet = loadPuppet(SAMPLES.leon, 'models/leon_puppet.mdl');
    expect(puppet.mesh.vertexCount).toBe(568);
    expect(puppet.mesh.blendIndices).not.toBeNull();
    expect(puppet.segments).toEqual({ mdls: 'ok', mdla: 'ok' });
    expect(puppet.bones).toHaveLength(13);
    expect(puppet.bones.map((b) => b.parent)).toEqual([-1, 0, 1, 2, 3, 3, 5, 6, 7, 3, 9, 10, 11]);
    expect(puppet.animations.map((a) => [a.id, a.mode, a.fps, a.frameCount])).toEqual([
      [47, 'loop', 30, 180],
      [49, 'loop', 30, 180],
      [51, 'loop', 30, 210],
      [59, 'loop', 30, 150],
    ]);
    expect(puppet.animations.every((a) => a.tracks.length === 13)).toBe(true);
    console.log(`[mdl] leon: bones=${puppet.bones.length} anims=${puppet.animations.map((a) => `${a.id}/${a.frameCount}f`).join(',')} verts=${puppet.mesh.vertexCount}`);
  });
});
