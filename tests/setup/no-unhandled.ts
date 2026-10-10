// vitest setupFiles 入口：把未处理异常（rejection / 测试外抛错）转成本文件的测试失败。
// 依据：2026-10-10 实测 vitest 2.1 遇到 unhandled rejection 时报告 success=true、exit 0，
// 门禁（scripts/check-known-failures.mjs）无从判红。全部 1054 项实测零命中，不会误报。
import { afterAll } from 'vitest';
import { createUnhandledGuard, installUnhandledHooks } from './unhandled-guard';

const guard = createUnhandledGuard();
installUnhandledHooks(guard);
afterAll(() => guard.assertEmpty());
