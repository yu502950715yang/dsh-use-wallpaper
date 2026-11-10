#!/usr/bin/env node
// 发布前单命令检查（release workflow 的 gate 与 `pnpm run verify:local` 的发布段共用；P0）。
// 四项，全部跑完再汇总，任一 FAIL → exit 1：
//   ① lib/ 与 dist/client.js 产物新鲜度：重跑构建后与 git 零差异（tag 必须构建自干净工作树）
//   ② wasm 溯源：dist/static 三件产物的 sha256/大小与 WASM_BUILD.json 一致，且 wasm 源码未在
//      清单生成后改动（清单由 scripts/gen-wasm-manifest.mjs 生成）
//   ③ npm pack 内容/体积断言：tarball ≤ 2.5 MiB、无 *.tex、无 src|tests|docs、wasm 三件在
//   ④ 发布元数据：package.json 有 engines.dsh；index.json 已有对应版本条目时其 engines 必须一致
//      （发布前索引尚无当前版本条目不判红，只提示——流程是 npm 发布后再补索引）
//
// 用法：node scripts/check-release.mjs
// 前提：已 `pnpm install`；② 需要 dist/static 三件产物与 dist/static/WASM_BUILD.json 已入库。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveQuickjsWasmPath } from './lib/quickjs-wasm-path.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = join(REPO, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));

const WASM_ARTIFACTS = [
  'dist/static/we_scene_wasm.js',
  'dist/static/we_scene_wasm_bg.wasm',
  'dist/static/quickjs.wasm',
];
const WASM_MANIFEST = 'dist/static/WASM_BUILD.json';
// 影响 wasm 产物的源码路径（与 gen-wasm-manifest.mjs 的 SOURCE_PATHS 同口径）
const WASM_SOURCE_PATHS = ['wasm/src', 'wasm/Cargo.toml', 'wasm/Cargo.lock'];
const TARBALL_LIMIT = 2.5 * 1024 * 1024;

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: REPO,
    encoding: 'utf8',
    shell: process.platform === 'win32',
    ...opts,
  });
}
function git(args) {
  const r = sh('git', args);
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
function outOf(r) {
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}
function tail(text, n = 1500) {
  const t = String(text ?? '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}
function sha256(rel) {
  const buf = readFileSync(join(REPO, rel));
  return { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
}
function sha256Abs(abs) {
  const buf = readFileSync(abs);
  return { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
}
function rel(path) {
  return path.replace(/\\/g, '/');
}

// ① 产物新鲜度（口径与 ci.yml / verify-local.mjs 一致：重跑构建后逐字节零差异）
function checkFreshness() {
  // lib/：先 git add -A 把「新增/删除的产物」也纳入比较（git diff 看不到未跟踪文件）
  const tsc = sh('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json']);
  if (tsc.status !== 0) throw new Error(`tsc 构建失败（exit ${tsc.status}）：\n${tail(outOf(tsc))}`);
  git(['add', '-A', '--', 'lib/']);
  const dLib = git(['diff', '--cached', '--no-ext-diff', '--exit-code', '--', 'lib/']);
  git(['reset', '-q', '--', 'lib/']); // 本地还原索引；CI 不需要
  if (dLib.code !== 0) {
    throw new Error(`lib/ 与 src 不同步 ⇒ 重建并提交 lib/（diff 摘要）：\n${tail(dLib.out)}`);
  }

  // dist/client.js：先删入库副本再构建，避免「构建失败 ⇒ 文件没变 ⇒ 误判同步」；
  // build:client 在缺 wasm/pkg 时于复制阶段 exit 1，但 client.js 此时已写出 ⇒ 只认 diff。
  const files = ['dist/client.js', 'dist/client.js.map'];
  for (const f of files) if (existsSync(join(REPO, f))) rmSync(join(REPO, f));
  const build = sh('node', ['scripts/build-client.mjs']);
  const dClient = git(['diff', '--no-ext-diff', '--exit-code', '--', 'dist/client.js']);
  if (dClient.code !== 0) {
    sh('git', ['checkout', '--', ...files]); // 别把工作树留在缺文件/半成品状态
    throw new Error(
      `dist/client.js 与 src 不同步 ⇒ 重建并提交（build:client exit ${build.status}）：\n${tail(outOf(build))}`,
    );
  }
  return `lib/ 0 diff / dist/client.js 0 diff`;
}

// ② wasm 溯源：三件产物哈希 + wasm 源码基线
function checkWasmProvenance() {
  const manifestPath = join(REPO, WASM_MANIFEST);
  if (!existsSync(manifestPath)) {
    throw new Error(`缺 ${WASM_MANIFEST} ⇒ 跑 \`node scripts/gen-wasm-manifest.mjs\` 生成并提交`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const recorded = manifest.artifacts ?? {};
  for (const relPath of WASM_ARTIFACTS) {
    if (!existsSync(join(REPO, relPath))) throw new Error(`缺 ${relPath}（build:client 的产物应入库）`);
    if (!recorded[relPath]) throw new Error(`${WASM_MANIFEST} 缺 ${relPath} 条目 ⇒ 重新生成清单`);
    const actual = sha256(relPath);
    if (actual.sha256 !== recorded[relPath].sha256 || actual.size !== recorded[relPath].size) {
      throw new Error(
        `${relPath} 与清单不一致（产物被重建/篡改）⇒ 更新清单：\n` +
          `  记录 ${recorded[relPath].size}B ${recorded[relPath].sha256}\n  实际 ${actual.size}B ${actual.sha256}`,
      );
    }
  }
  // quickjs.wasm 是 node_modules 源文件的直接复制 ⇒ 源哈希必须与清单一致（lockfile 漂移会抓到）
  // 源路径随包管理器布局变化（npm 顶层 / pnpm .pnpm），用解析器定位而不是拼固定路径。
  const q = manifest.quickjs ?? {};
  const qSrcAbs = resolveQuickjsWasmPath(REPO);
  if (qSrcAbs && q.sha256) {
    const srcHash = sha256Abs(qSrcAbs).sha256;
    if (srcHash !== q.sha256) {
      throw new Error(`quickjs.wasm 与 node_modules 源不一致（依赖版本漂移？）⇒ 重建 build:client + 重新生成清单`);
    }
  }
  // wasm 源码基线：清单之后改过 wasm/src、Cargo.toml、Cargo.lock ⇒ 产物不可信
  const src = manifest.source ?? {};
  if (src.wasmSrcDirty) throw new Error('清单记录时 wasm 源码是脏的 ⇒ 提交源码后重新构建并重跑 gen-wasm-manifest');
  const head = git(['log', '-1', '--format=%H', '--', ...WASM_SOURCE_PATHS]).out;
  if (!head) throw new Error('无法读取 wasm 源码 commit（需要 git 仓库）');
  if (head !== src.wasmSrcCommit) {
    throw new Error(
      `wasm 源码在清单生成后被改动（清单 ${String(src.wasmSrcCommit).slice(0, 12)}… ≠ HEAD ${head.slice(0, 12)}…）⇒ ` +
        '重建 wasm（build:wasm + build:client）后重跑 gen-wasm-manifest',
    );
  }
  return `3 件 sha256/大小一致；wasm 源码基线 ${head.slice(0, 12)}…（${manifest.toolchain?.rustc ?? '?'} / wasm-pack ${manifest.toolchain?.wasmPack ?? '?'}）`;
}

// ③ npm pack 内容与体积
function checkPack() {
  const r = sh('npm', ['pack', '--dry-run', '--json']);
  if (r.status !== 0) throw new Error(`npm pack --dry-run 失败（exit ${r.status}）：\n${tail(outOf(r))}`);
  const stdout = r.stdout ?? '';
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error(`无法解析 npm pack --json 输出：\n${tail(stdout)}`);
  const info = JSON.parse(stdout.slice(start, end + 1))[0];
  if (!info) throw new Error('npm pack --json 未返回包信息');
  const files = (info.files ?? []).map((f) => rel(f.path));

  const problems = [];
  if (info.version !== pkg.version) problems.push(`版本不一致：pack ${info.version} ≠ package.json ${pkg.version}`);
  if (info.size > TARBALL_LIMIT) {
    problems.push(`tarball ${(info.size / 1024 / 1024).toFixed(2)} MiB > 上限 2.5 MiB`);
  }
  const tex = files.filter((p) => /\.tex$/i.test(p));
  if (tex.length) problems.push(`含 ${tex.length} 个 .tex（不得分发第三方素材）：${tex.slice(0, 3).join(', ')}…`);
  const leaked = files.filter((p) => /^(src|tests|docs)\//.test(p));
  if (leaked.length) problems.push(`含源码/测试/文档 ${leaked.length} 个：${leaked.slice(0, 3).join(', ')}…`);
  const missing = [...WASM_ARTIFACTS, WASM_MANIFEST].filter((p) => !files.includes(p));
  if (missing.length) problems.push(`缺发布必需文件：${missing.join(', ')}`);
  if (problems.length) throw new Error(problems.join('\n  '));
  return `tarball ${(info.size / 1024 / 1024).toFixed(2)} MiB / ${files.length} files；wasm 三件 + 清单齐全，无 .tex、无 src/tests/docs`;
}

// ④ 发布元数据：engines.dsh 与市场索引一致
function checkMetadata() {
  const engine = pkg.engines?.dsh;
  if (!engine) {
    throw new Error(
      'package.json 缺 engines.dsh（1.0 发布 P0 元数据；示例 ">=0.2.0-rc.1 <0.3.0"）——' +
        '运行时只按包清单判定兼容，index.json 的 engines 不参与',
    );
  }
  const index = JSON.parse(readFileSync(join(REPO, 'index.json'), 'utf8'));
  const plugin = (index.plugins ?? []).find((p) => p.name === pkg.name) ?? (index.plugins ?? [])[0];
  if (!plugin) throw new Error('index.json 中没有 plugins 条目');
  if (plugin.name !== pkg.name) throw new Error(`index.json 插件名 ${plugin.name} ≠ package.json ${pkg.name}`);
  const versions = plugin.versions ?? [];
  const entry = versions.find((v) => v.version === pkg.version);
  if (!entry) {
    const latest = versions[versions.length - 1];
    return {
      ok: true,
      warn: true,
      detail:
        `index.json 尚未收录 v${pkg.version}（最新 ${latest?.version ?? '无'}）——` +
        '发布后必须补条目（engines.dsh 与包清单一致），发布前不判红',
    };
  }
  const idxEngine = entry.engines?.dsh;
  if (idxEngine !== engine) {
    throw new Error(`index.json v${pkg.version} 的 engines.dsh="${idxEngine}" ≠ package.json "${engine}" ⇒ 两处同步`);
  }
  return { ok: true, detail: `engines.dsh="${engine}"（package.json 与 index.json v${pkg.version} 一致）` };
}

const CHECKS = [
  ['① 产物新鲜度（lib/ + dist/client.js 与 src 同步）', checkFreshness],
  ['② wasm 产物溯源（sha256 与 WASM_BUILD.json 一致）', checkWasmProvenance],
  ['③ npm pack 内容/体积（≤2.5 MiB、无 .tex、无源码）', checkPack],
  ['④ 发布元数据（engines.dsh 与 index.json 一致）', checkMetadata],
];

const rows = [];
for (const [name, fn] of CHECKS) {
  let result;
  try {
    result = fn();
    rows.push({ name, ok: true, warn: Boolean(result?.warn), detail: typeof result === 'string' ? result : (result?.detail ?? '') });
  } catch (e) {
    rows.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

console.log('============ 发布前检查（check-release） ============');
for (const r of rows) {
  const tag = r.ok ? (r.warn ? 'WARN' : 'PASS') : 'FAIL';
  console.log(`${tag}  ${r.name}`);
  if (r.detail) console.log(`      ${r.detail.split('\n').join('\n      ')}`);
}
const failed = rows.filter((r) => !r.ok);
console.log(failed.length === 0 ? '\n结论：发布前检查全部通过 ✅' : `\n结论：${failed.length} 项未通过 ❌`);
process.exit(failed.length === 0 ? 0 : 1);
