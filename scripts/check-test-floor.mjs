// 测试数下限守卫（审查 P0-1）：门禁只判「红」时，删除测试文件 / 写错 vitest include / 把断言
// 删成空转，都能让整库用例静默消失且三道门禁全绿。本脚本校验 vitest json 报告的「规模」：
//   testResults 非空、用例数 ≥ minTests、文件数 ≥ minTestFiles、跳过/待办 ≤ maxPendingTests。
// 下限见 scripts/test-floor.json（新增测试后按需同步；这是允许变大的方向，变小需显式改）。
// 用法：node scripts/check-test-floor.mjs [vitest-json-report]
// 测试可用 TEST_FLOOR 环境变量注入自己的下限文件。
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const reportPath = process.argv[2] ?? '.vitest-report.json';
const floorPath = process.env.TEST_FLOOR ?? resolve('scripts/test-floor.json');

function die(...lines) {
  for (const l of lines) console.error(`[test-floor] ${l}`);
  process.exit(1);
}

if (!existsSync(reportPath)) {
  die(`找不到测试报告：${reportPath}（vitest 可能崩溃/被中断；verify-local 已先删旧报告，不应读到上一轮结果）`);
}
if (!existsSync(floorPath)) die(`找不到下限文件：${floorPath}`);

const floor = JSON.parse(readFileSync(floorPath, 'utf8'));
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const files = Array.isArray(report.testResults) ? report.testResults.length : 0;
const total = Number(report.numTotalTests ?? 0);
const pending = Number(report.numPendingTests ?? 0) + Number(report.numTodoTests ?? 0);
const errs = [];

if (files === 0) errs.push('报告里没有任何测试文件（include 配置写错 / 收集阶段崩溃 / 测试被整体删除？）');
if (files < (floor.minTestFiles ?? 0)) errs.push(`测试文件数 ${files} < 下限 ${floor.minTestFiles}`);
if (total < (floor.minTests ?? 0)) errs.push(`用例数 ${total} < 下限 ${floor.minTests}`);
if (pending > (floor.maxPendingTests ?? Number.POSITIVE_INFINITY)) {
  errs.push(`跳过/待办 ${pending} > 上限 ${floor.maxPendingTests}`);
}

if (errs.length > 0) die(...errs);
console.log(`[test-floor] 文件 ${files}、用例 ${total}、跳过 ${pending} —— 均在约定范围内 ✅`);
