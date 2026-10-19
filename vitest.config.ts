import { defineConfig } from 'vitest/config';
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environmentMatchGlobs: [['tests/dom/**', 'jsdom']],
    // 临时插件数据目录（防写真实 home）+ 未处理异常转失败。
    // 未处理异常既不进 json 报告也不改退出码（vitest 2.1 实测）⇒ 由 no-unhandled 转成测试失败
    setupFiles: ['tests/setup/temp-data-dir.ts', 'tests/setup/no-unhandled.ts'],
  },
});
