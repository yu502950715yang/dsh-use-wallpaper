import { describe, expect, it, afterEach } from 'vitest';
import { makeTex } from './fixtures/make-tex.js';
import {
  parseTex, setTexBudget, getTexBudget, DEFAULT_TEX_BUDGET, expectedDecompressedBytes, TEX_FORMAT,
} from '../src/client/tex-loader.js';

// S3 加固回归（2026-11-10）：纹理解压预算与「按 format+尺寸推导分配」。
// 设计见 docs/fixes/audit-2026-11-10-summary.md / summary.md；阈值可通过 profile config 调整，
// client 启动时由 index.ts 注入（setTexBudget）；这里直接测注入后的行为。
//
// 攻击形态：mip 记录声明巨大 decompressedBytes（或巨大宽高）→ 修复前直接 new Uint8Array(声明值)，
// 64 image × 256 mip 即可让渲染进程 OOM。修复后：分配按推导值、超预算拒绝、空载荷拒绝。

afterEach(() => setTexBudget()); // 恢复默认（防止用例间泄漏）

const mip = (width: number, height: number, data: Uint8Array, extra: Record<string, unknown> = {}) =>
  ({ width, height, data, ...extra }) as never;

describe('S3：正常素材零误伤（推导值分配）', () => {
  it('DXT5 4×4 LZ4（declared == 推导值）正常解析，解压数据一致', () => {
    const raw = new Uint8Array(16).fill(9);
    const buf = makeTex({ format: TEX_FORMAT.DXT5, images: [[mip(4, 4, raw, { lz4: true })]] });
    const info = parseTex(buf)!;
    expect(info.mipmaps).toHaveLength(1);
    expect(info.mipmaps[0]!.data).toEqual(raw);
  });

  it('RGBA 多 mip LZ4 正常解析（默认预算下 8K 级别仍通过）', () => {
    const raw0 = new Uint8Array(64 * 32 * 4).fill(1);
    const raw1 = new Uint8Array(32 * 16 * 4).fill(2);
    const buf = makeTex({
      format: TEX_FORMAT.RGBA8888,
      images: [[mip(64, 32, raw0, { lz4: true }), mip(32, 16, raw1, { lz4: true })]],
    });
    const info = parseTex(buf)!;
    expect(info.mipmaps).toHaveLength(2);
    expect(info.mipmaps[0]!.data).toEqual(raw0);
    expect(info.mipmaps[1]!.data).toEqual(raw1);
  });

  it('推导函数覆盖各格式（DXT1/DXT3/DXT5/RGBA/RG88/R8，未知格式返回 0）', () => {
    expect(expectedDecompressedBytes(TEX_FORMAT.DXT1, 8, 8)).toBe(2 * 2 * 8);
    expect(expectedDecompressedBytes(TEX_FORMAT.DXT3, 8, 8)).toBe(2 * 2 * 16);
    expect(expectedDecompressedBytes(TEX_FORMAT.DXT5, 8, 8)).toBe(2 * 2 * 16);
    expect(expectedDecompressedBytes(TEX_FORMAT.RGBA8888, 8, 8)).toBe(8 * 8 * 4);
    expect(expectedDecompressedBytes(TEX_FORMAT.RG88, 8, 8)).toBe(8 * 8 * 2);
    expect(expectedDecompressedBytes(TEX_FORMAT.R8, 8, 8)).toBe(8 * 8);
    expect(expectedDecompressedBytes(99, 8, 8)).toBe(0);
  });
});

describe('S3：恶意/异常素材被拒绝', () => {
  it('LZ4 空载荷 + 巨大声明（炸弹形态）→ null（不再按声明分配）', () => {
    // DXT5 2048×2048 推导 = 4 MiB；payload 为空（lz4 空输入 → 0 字节）
    const buf = makeTex({
      format: TEX_FORMAT.DXT5,
      images: [[mip(2048, 2048, new Uint8Array(0), { lz4: true, declaredBytes: 4 * 1024 * 1024 })]],
    });
    expect(parseTex(buf)).toBeNull();
  });

  it('声明解压尺寸与推导值不一致 → null（异常素材特征）', () => {
    const raw = new Uint8Array(16).fill(3);
    const buf = makeTex({
      format: TEX_FORMAT.DXT5,
      images: [[mip(4, 4, raw, { lz4: true, declaredBytes: 32 })]],
    });
    expect(parseTex(buf)).toBeNull();
  });

  it('LZ4 + 未知 format → null（无法推导安全分配大小）', () => {
    const raw = new Uint8Array(16);
    const buf = makeTex({ format: 99, images: [[mip(4, 4, raw, { lz4: true, declaredBytes: 16 })]] });
    expect(parseTex(buf)).toBeNull();
  });

  it('单 mip 超出推导尺寸上限（maxDimension）→ null', () => {
    setTexBudget({ maxDimension: 64 });
    const raw = new Uint8Array(65 * 4);
    const buf = makeTex({ format: TEX_FORMAT.RGBA8888, images: [[mip(65, 1, raw, { lz4: true })]] });
    expect(parseTex(buf)).toBeNull();
  });
});

describe('S3：预算可配置（profile config 调整后立即生效）', () => {
  it('maxMipBytes：调小后同样素材被拒，恢复默认后通过（证明阈值来自配置）', () => {
    const raw = new Uint8Array(8 * 8 * 4); // RGBA 8×8 = 256 B
    const buf = makeTex({ format: TEX_FORMAT.RGBA8888, images: [[mip(8, 8, raw, { lz4: true })]] });
    expect(parseTex(buf)).not.toBeNull(); // 默认预算下通过

    setTexBudget({ maxMipBytes: 100 });
    expect(parseTex(buf)).toBeNull();     // 调小后拒绝

    setTexBudget();                        // 恢复默认
    expect(parseTex(buf)).not.toBeNull();
  });

  it('maxMipCount：调小后多 mip 纹理被拒', () => {
    const buf = makeTex({
      format: TEX_FORMAT.RGBA8888,
      images: [[
        mip(8, 8, new Uint8Array(256), { lz4: true }),
        mip(4, 4, new Uint8Array(64), { lz4: true }),
        mip(2, 2, new Uint8Array(16), { lz4: true }),
      ]],
    });
    expect(parseTex(buf)).not.toBeNull();
    setTexBudget({ maxMipCount: 2 });
    expect(parseTex(buf)).toBeNull();
  });

  it('maxTextureBytes：调小后总解压量超预算被拒', () => {
    const buf = makeTex({
      format: TEX_FORMAT.RGBA8888,
      images: [[
        mip(8, 8, new Uint8Array(256), { lz4: true }),
        mip(8, 8, new Uint8Array(256), { lz4: true }),
      ]],
    });
    setTexBudget({ maxTextureBytes: 300 });
    expect(parseTex(buf)).toBeNull(); // 256+256 > 300
  });

  it('非法配置值（0 / 负数 / NaN）回退默认值', () => {
    setTexBudget({ maxMipBytes: 0, maxTextureBytes: Number.NaN, maxMipCount: -5, maxDimension: 0 });
    expect(getTexBudget()).toEqual(DEFAULT_TEX_BUDGET as unknown as Record<string, number>);
  });
});
