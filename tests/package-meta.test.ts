import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// C2 元数据冒烟测试：DSH 的 client-modules 只加载声明 dsh.client 且
// exports 暴露 ./client 的包（参照 @deepseek-ai/dsh-client-modules 体例）。
// 断言 exports 值即可，不依赖 dist 产物存在（dist/client.js 由 build:client 产出）。

const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
  exports?: Record<string, unknown>;
  dsh?: { profile?: unknown; client?: { platform?: unknown; inject?: unknown; immediately?: unknown } };
};

describe('package dsh metadata', () => {
  it('声明 dsh.client（platform=web）供 DSH client-modules 加载', () => {
    expect(pkg.dsh).toBeDefined();
    expect(pkg.dsh!.client).toBeDefined();
    expect(pkg.dsh!.client!.platform).toBe('web');
    expect(pkg.dsh!.client!.immediately).toBe(true);
    expect(Array.isArray(pkg.dsh!.client!.inject)).toBe(true);
  });
  it('exports 暴露 ./client 子路径（build:client 的产物出口）', () => {
    expect(pkg.exports).toBeDefined();
    const clientExport = (pkg.exports as Record<string, { default?: string }>)['./client'];
    expect(clientExport).toBeDefined();
    expect(clientExport.default).toBe('./dist/client.js');
  });
});
