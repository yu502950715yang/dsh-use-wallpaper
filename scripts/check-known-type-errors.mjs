// 测试侧已知类型错误基线检查：只对**新增/加重**的类型错误判红（见 AGENT.md §7.11）。
//
// 用法：node scripts/check-known-type-errors.mjs [--update]
//   --update 重建 scripts/known-type-errors.json 并打印差异摘要，永远 exit 0
// 口径：跑 `tsc -p tsconfig.tests.json --noEmit`，按 **（文件, TS 错误码）计数**回落基线 ——
//   行号/列号不进指纹（无关改动会漂行号，进指纹就是假红）；计数变少只提示、不判红。
// 退出码：0 = 无新增类型错误；1 = 出现新键或计数变大，或 tsc 未能正常运行。
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const CONFIG = 'tsconfig.tests.json';
const baselinePath = resolve('scripts/known-type-errors.json');
const update = process.argv.includes('--update');

// `--pretty false` 强制纯文本单行报错（不随 tsc 版本/终端变色），否则解析口径会漂
const r = spawnSync('pnpm', ['exec', 'tsc', '-p', CONFIG, '--noEmit', '--pretty', 'false'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
  maxBuffer: 64 * 1024 * 1024,
});
const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const lines = raw.split(/\r?\n/);
if (r.error) {
  console.error(`[known-type-errors] 无法执行 \`pnpm exec tsc -p ${CONFIG}\`：${r.error.message}`);
  process.exit(1);
}
// 只认「文件(行,列): error TSxxxx:」，多行报错的续行与 `error TS` 配置级报错都不含该前缀
const LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;

const errors = [];
const configErrors = [];
for (const line of lines) {
  const m = LINE.exec(line);
  if (!m) {
    if (/^error TS\d+:/.test(line)) configErrors.push(line);
    continue;
  }
  const file = m[1].replace(/\\/g, '/').replace(/^\.\//, '');
  errors.push({ file, code: m[4], message: m[5] });
}

const key = (e) => `${e.file}|${e.code}`;
/** 当前错误 → { "文件|TSxxxx": 计数 }，按 key 排序输出（基线 diff 才可读）。 */
function fingerprint(list) {
  const counts = {};
  for (const e of list) counts[key(e)] = (counts[key(e)] ?? 0) + 1;
  return Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
}
const current = fingerprint(errors);
const total = errors.length;

if (configErrors.length > 0) {
  console.error(`\n[known-type-errors] tsc 未能正常运行（配置级错误 ${configErrors.length} 条）：`);
  for (const l of configErrors.slice(0, 20)) console.error(`  TS CONFIG  ${l}`);
  process.exit(1);
}
if (errors.length === 0 && r.status !== 0) {
  console.error(`\n[known-type-errors] tsc exit ${r.status} 但未解析到任何「文件(行,列): error TSxxxx」行，输出口径可能变了：`);
  console.error(raw.split(/\r?\n/).slice(0, 20).join('\n'));
  process.exit(1);
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : { errors: {} };
const known = baseline.errors ?? {};
const added = [];
const grown = [];
const shrunk = [];
for (const k of Object.keys(current)) {
  const was = known[k] ?? 0;
  if (was === 0) added.push({ key: k, now: current[k] });
  else if (current[k] > was) grown.push({ key: k, was, now: current[k] });
}
for (const k of Object.keys(known)) {
  const was = known[k];
  const now = current[k] ?? 0;
  if (now < was) shrunk.push({ key: k, was, now });
}

const parseFile = (k) => k.slice(0, k.lastIndexOf('|'));
const parseCode = (k) => k.slice(k.lastIndexOf('|') + 1);

// 示例信息取「当前错误清单里该 key 的第一条」，方便直接定位（行号只用于打印，不进指纹）
const firstMessage = (k) => errors.find((e) => key(e) === k);

if (update) {
  const newBaseline = {
    _comment:
      'tests 侧已知类型错误基线（详见 AGENT.md §7.11）。口径 = (文件, TS 错误码) 计数：出现新键或计数变大 → 门禁红；计数变小只提示，请随手 `--update` 收紧。基线**不含行号/列号**（否则无关改动会漂出假红）。',
    errors: current,
  };
  writeFileSync(baselinePath, `${JSON.stringify(newBaseline, null, 2)}\n`, 'utf8');
  console.log(`[known-type-errors] 已更新 ${baselinePath}：${Object.keys(current).length} 个 (文件,码) 键、${total} 条类型错误`);
  for (const a of added) console.log(`  +${a.now}  ${parseFile(a.key)}`);
  for (const g of grown) console.log(`  ${g.was}→${g.now}  ${parseFile(g.key)}`);
  for (const s of shrunk) console.log(`  -${s.was - s.now}  ${parseFile(s.key)}`);
  process.exit(0);
}

console.log(
  `[known-type-errors] 类型错误 ${total} 条、${Object.keys(current).length} 个 (文件,码) 键（基线 ${Object.keys(known).length} 键）`,
);
for (const a of added) {
  const e = firstMessage(a.key);
  console.log(`  基线外新增（预期外）：${parseFile(a.key)} → ${parseCode(a.key)} ×${a.now}${e ? `  首条：${e.message}` : ''}`);
}
for (const s of shrunk) {
  console.log(`  ✅ 已修复，可从基线移除：${parseFile(s.key)} → ${parseCode(s.key)}（基线 ${s.was} → 现 ${s.now}）`);
}

if (added.length > 0 || grown.length > 0) {
  console.error(`\n[known-type-errors] 类型错误基线恶化（新键 ${added.length} 个、计数变大 ${grown.length} 个）：`);
  for (const a of added) {
    console.error(`  NEW KEY   ${a.key} ×${a.now}`);
    const e = firstMessage(a.key);
    if (e) console.error(`            首条：${e.message}`);
  }
  for (const g of grown) console.error(`  MORE      ${g.key} ${g.was} → ${g.now}`);
  console.error('  若确认是既有口径下的合理新增，先修类型；确需放宽才跑 `node scripts/check-known-type-errors.mjs --update`。');
  process.exit(1);
}

console.log('[known-type-errors] 无新增类型错误 ✅');
