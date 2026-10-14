import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseMdl } from '../src/client/mdl-parser.js';

// 本机唯一样本：死亡搁浅-玛玛（pkg 内 models/20240220213723_1_puppet.mdl，110892 B）。
const PKG = 'D:/Steam/steamapps/workshop/content/431960/3303428996/scene.pkg';
const hasLib = existsSync(PKG);

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

if (!hasLib) {
  console.warn(`[mdl-real-library] 未找到样本 ${PKG} —— 真实 puppet 冒烟本次跳过（CI 上属预期）`);
}

describe.skipIf(!hasLib)('真实 puppet 样本（本机库）', () => {
  it('解析出门 3303428996 的 MDL（几何必成功；骨骼/蒙皮/动画数列入日志不作断言）', () => {
    const pkg = readFileSync(PKG);
    const bytes = readEntry(pkg, (n) => n.toLowerCase().endsWith('.mdl'));
    expect(bytes, 'pkg 内应有 .mdl 条目').not.toBeNull();
    const r = parseMdl(bytes as Uint8Array);
    expect(r.ok, r.ok ? '' : (r as { error: string }).error).toBe(true);
    if (!r.ok) return;
    // 硬判据：只有「解析器落到正确段」才能成立的部分（顶点数 + 索引全部在范围内）
    expect(r.puppet.mesh.vertexCount).toBeGreaterThan(0);
    for (const v of r.puppet.mesh.indices) expect(v).toBeLessThan(r.puppet.mesh.vertexCount);
    expect(r.puppet.mesh.materialPath.endsWith('.json')).toBe(true);
    // 骨骼 / 蒙皮权重 / 动画：该样本实测**没有** MDLS/MDLA/MDLE 段（详见 AGENT.md §7.40）
    // ⇒ 只记录不断言；断言 bones>0 会把「如实解析出的空骨表」判成红，属迁就测试而非迁就事实。
    console.log(`[mdl] version=${r.puppet.version} stride=${r.puppet.mesh.strideInfo.stride} verts=${r.puppet.mesh.vertexCount} indices=${r.puppet.mesh.indices.length} bones=${r.puppet.bones.length} anims=${r.puppet.animations.length}`);
    console.log(`[mdl] maxIndex=${r.puppet.mesh.strideInfo.maxIndex} strideReason=${r.puppet.mesh.strideInfo.reason} blendWeights=${r.puppet.mesh.blendWeights === null ? 'null' : 'present'} material=${r.puppet.mesh.materialPath}`);
  });
});
