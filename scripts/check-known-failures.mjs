// 已知失败基线检查：只对**新增**失败判红（见 AGENT.md §7.11 与 scripts/known-failures.json）。
//
// 用法：node scripts/check-known-failures.mjs <vitest-json-report>
//   生成报告：npx vitest run --reporter=json --outputFile=.vitest-report.json
// 退出码：0 = 无新增失败；1 = 出现基线之外的失败，或报告不可读。
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const reportPath = process.argv[2] ?? '.vitest-report.json';
const baselinePath = resolve('scripts/known-failures.json');

if (!existsSync(reportPath)) {
  console.error(`[known-failures] 找不到测试报告：${reportPath}`);
  process.exit(1);
}

/** 报告里的文件路径（可能是绝对路径）→ 仓库相对、正斜杠形式。 */
function relFile(name) {
  return name.replace(/\\/g, '/').replace(/^.*?(tests\/)/, '$1');
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const key = (file, name) => `${file}::${name}`;
const known = new Set((baseline.failures ?? []).map((f) => key(f.file, f.name)));

const failed = [];
for (const file of report.testResults ?? []) {
  const rel = relFile(file.name ?? '');
  for (const a of file.assertionResults ?? []) {
    if (a.status === 'failed') {
      // vitest 的 fullName 用空格拼接，这里按 `describe > it` 重建，与基线表/日志口径一致
      const name = [...(a.ancestorTitles ?? []), a.title ?? ''].join(' > ');
      failed.push({ file: rel, name });
    }
  }
}

const added = failed.filter((f) => !known.has(key(f.file, f.name)));
const stillFailing = failed.filter((f) => known.has(key(f.file, f.name)));
const absent = (baseline.failures ?? []).filter(
  (f) => !failed.some((x) => x.file === f.file && x.name === f.name),
);

const totals = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
console.log(`[known-failures] 总计 ${totals}，通过 ${passed}，失败 ${failed.length}（基线内 ${stillFailing.length}）`);

for (const f of stillFailing) console.log(`  基线内失败（预期）：${f.file} > ${f.name}`);
for (const f of absent) console.log(`  ⚠️ 基线内条目本次未失败（已修复或本机跳过）：${f.file} > ${f.name}`);

if (added.length > 0) {
  console.error(`\n[known-failures] 出现 ${added.length} 项**新增失败**（基线之外）：`);
  for (const f of added) console.error(`  NEW FAIL  ${f.file} > ${f.name}`);
  process.exit(1);
}

console.log('[known-failures] 无新增失败 ✅');
