// 架构边界守卫（AGENT.md §2 分层契约的可执行版）：纯 Node 源码扫描，无依赖。
//
// 规则（零容忍；违规即 exit 1）：
//   host-not-client         src/host/**    不得依赖 src/client/**（host 是 Node 侧，client 是浏览器侧）
//   client-not-host         src/client/**  不得依赖 src/host/**
//   shared-pure             src/shared/**  不得依赖 host/client（两端共用，必须纯）
//   browser-no-node         client/shared  不得 import `node:*`（浏览器 bundle 里没有 Node 内置）
//   host-no-browser-lib     src/host/**    不得 import three / react / react-dom（Node 侧不跑浏览器库）
//   src-no-build-output     src/**         不得依赖 lib/、dist/、tests/、e2e/、research/（产物/测试反向依赖）
//
// 守卫自身也要有红测：脚本默认先跑 `--self-test`（每条规则至少一份「必须报红」的合成样本 +
// 正例不误报），自检失败同样 exit 1 —— 规则写错了不会静默变绿（变异红测制度化的最小形态）。
//
// 用法：
//   node scripts/verify-arch.mjs            # 自检 + 扫描 src
//   node scripts/verify-arch.mjs --no-self-test
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toPosix = (p) => p.replace(/\\/g, '/');
const REPO_POSIX = toPosix(REPO);

const RULES = [
  {
    id: 'host-not-client',
    applies: (rel) => rel.startsWith('src/host/'),
    violation: (abs) => abs.startsWith(REPO_POSIX + '/src/client/'),
    message: 'host 不得依赖 client（跨运行时边界；需要共用纯函数请下沉 src/shared）',
  },
  {
    id: 'client-not-host',
    applies: (rel) => rel.startsWith('src/client/'),
    violation: (abs) => abs.startsWith(REPO_POSIX + '/src/host/'),
    message: 'client 不得依赖 host（浏览器 bundle 里没有 Node 侧模块）',
  },
  {
    id: 'shared-pure',
    applies: (rel) => rel.startsWith('src/shared/'),
    violation: (abs) => abs.startsWith(REPO_POSIX + '/src/host/') || abs.startsWith(REPO_POSIX + '/src/client/'),
    message: 'shared 必须纯（两端共用）；依赖 host/client 会造成循环与打包边界破坏',
  },
  {
    id: 'browser-no-node',
    applies: (rel) => rel.startsWith('src/client/') || rel.startsWith('src/shared/'),
    violation: null, // 由 bareSpecifier 判定，见下
    message: '浏览器侧不得 import node:* 内置',
  },
  {
    id: 'host-no-browser-lib',
    applies: (rel) => rel.startsWith('src/host/'),
    violation: null,
    message: 'host 侧不得 import 浏览器库（three/react/react-dom）',
  },
  {
    id: 'src-no-build-output',
    applies: () => true,
    violation: (abs) => ['lib', 'dist', 'tests', 'e2e', 'research'].some((d) => abs.startsWith(`${REPO_POSIX}/${d}/`)),
    message: '源码不得反向依赖构建产物 / 测试 / 研究目录',
  },
];

// 去掉注释但保留行号（把注释字符替换为空格，换行保留）。
function stripComments(code) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    // block
    if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
    out += c === '\n' ? '\n' : ' '; i++;
  }
  return out;
}

/** 提取 import/export-from/动态 import/require 的模块说明符（附带行号）。 */
function extractSpecs(code) {
  const clean = stripComments(code);
  const specs = [];
  const push = (spec, index) => {
    const line = clean.slice(0, index).split('\n').length;
    specs.push({ spec, line });
  };
  // import ... from 'x' / export ... from 'x'（含 import type / export type）
  for (const m of clean.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^;'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g)) push(m[1], m.index ?? 0);
  // 动态 import('x')
  for (const m of clean.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], m.index ?? 0);
  // require('x')
  for (const m of clean.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) push(m[1], m.index ?? 0);
  return specs;
}

const NODE_BUILTIN_RE = /^node:/;
const BROWSER_LIBS = new Set(['three', 'react', 'react-dom', 'react/jsx-runtime']);

/** 对单个文件做规则检查；返回 [{ ruleId, spec, line }]。fileRel 用 posix 相对路径（如 src/host/a.ts）。 */
function checkFile(fileRel, code) {
  const fileAbs = toPosix(resolve(REPO, fileRel));
  const violations = [];
  for (const { spec, line } of extractSpecs(code)) {
    // 规则 1/2/3/6：相对说明符解析成绝对路径再判目录
    if (spec.startsWith('.')) {
      const abs = toPosix(resolve(dirname(fileAbs), spec));
      for (const rule of RULES) {
        if (!rule.violation || !rule.applies(fileRel)) continue;
        if (rule.violation(abs)) violations.push({ ruleId: rule.id, spec, line });
      }
      continue;
    }
    // 规则 4：浏览器侧禁 node 内置
    if (RULES[3].applies(fileRel) && NODE_BUILTIN_RE.test(spec)) {
      violations.push({ ruleId: 'browser-no-node', spec, line });
      continue;
    }
    // 规则 5：host 侧禁浏览器库（含子路径 three/examples 等）
    if (RULES[4].applies(fileRel)) {
      const root = spec.split('/')[0];
      if (BROWSER_LIBS.has(spec) || BROWSER_LIBS.has(root)) {
        violations.push({ ruleId: 'host-no-browser-lib', spec, line });
      }
    }
  }
  return violations;
}

// ── 自检：每条规则至少一个「必须报红」样本 + 正例不误报 ──────────────────────
const SELF_SAMPLES = [
  { file: 'src/host/a.ts', code: "import { x } from '../client/b.js';", expect: ['host-not-client'] },
  { file: 'src/client/a.ts', code: "import { x } from '../host/b.js';", expect: ['client-not-host'] },
  { file: 'src/shared/a.ts', code: "import { x } from '../client/b.js';", expect: ['shared-pure'] },
  { file: 'src/shared/a.ts', code: "export { x } from '../host/b.js';", expect: ['shared-pure'] },
  { file: 'src/client/a.ts', code: "import fs from 'node:fs';", expect: ['browser-no-node'] },
  { file: 'src/shared/a.ts', code: "const m = await import('node:path');", expect: ['browser-no-node'] },
  { file: 'src/host/a.ts', code: "import * as THREE from 'three';", expect: ['host-no-browser-lib'] },
  { file: 'src/client/a.ts', code: "import { x } from '../../lib/client/b.js';", expect: ['src-no-build-output'] },
  { file: 'src/host/a.ts', code: "const y = require('../../dist/x.js');", expect: ['src-no-build-output'] },
  // 正例（不得误报）
  { file: 'src/client/a.ts', code: "import * as THREE from 'three';", expect: [] },
  { file: 'src/host/a.ts', code: "import { parseUserRef } from '../shared/user-refs.js';", expect: [] },
  { file: 'src/client/a.ts', code: "import { x } from '../shared/types.js';", expect: [] },
  { file: 'src/client/a.ts', code: "// import { x } from '../host/b.js';\nconst a = 1;", expect: [] },
  { file: 'src/client/a.ts', code: "/* import { x } from '../host/b.js'; */\nconst a = 1;", expect: [] },
  { file: 'src/host/a.ts', code: "import { join } from 'node:path';", expect: [] },
];

function selfTest() {
  const failures = [];
  const covered = new Set();
  for (const s of SELF_SAMPLES) {
    const got = [...new Set(checkFile(s.file, s.code).map((v) => v.ruleId))].sort();
    const want = [...s.expect].sort();
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures.push({ sample: `${s.file}: ${s.code.split('\n')[0]}`, want, got });
    }
    for (const id of want) covered.add(id);
  }
  for (const rule of RULES) {
    if (!covered.has(rule.id)) failures.push({ sample: `规则 ${rule.id} 没有任何「必须报红」的样本`, want: [rule.id], got: [] });
  }
  if (failures.length > 0) {
    console.error('[verify-arch] 自检失败（规则自身不可信）：');
    for (const f of failures) console.error(`  - ${f.sample}\n    期望 ${JSON.stringify(f.want)}，实得 ${JSON.stringify(f.got)}`);
    process.exit(1);
  }
  console.log(`[verify-arch] 自检通过：${RULES.length} 条规则均有红测样本（${SELF_SAMPLES.length} 份）`);
}

// ── 扫描真实源码 ─────────────────────────────────────────────────────────────
function walk(dir) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function scan() {
  const files = walk(join(REPO, 'src'));
  const violations = [];
  for (const file of files) {
    const rel = toPosix(relative(REPO, file));
    const code = readFileSync(file, 'utf8');
    for (const v of checkFile(rel, code)) violations.push({ file: rel, ...v });
  }
  if (violations.length > 0) {
    console.error(`[verify-arch] 发现 ${violations.length} 处架构违规：`);
    for (const v of violations) {
      const rule = RULES.find((r) => r.id === v.ruleId);
      console.error(`  ${v.file}:${v.line}  [${v.ruleId}]  ${rule?.message ?? ''}\n    依赖：${v.spec}`);
    }
    process.exit(1);
  }
  console.log(`[verify-arch] 扫描 ${files.length} 个文件：分层/环境边界全部合规`);
}

const argv = process.argv.slice(2);
if (!argv.includes('--no-self-test')) selfTest();
scan();
