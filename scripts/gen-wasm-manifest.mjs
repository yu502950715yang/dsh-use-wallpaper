#!/usr/bin/env node
// 生成 dist/static/WASM_BUILD.json：wasm 分发产物的构建溯源（P0，见 docs/release-1.0/release-engineering.md §B.9）。
//
// 记录：wasm/src 最后改动 commit + 是否脏、rustc/cargo/wasm-pack 版本、三件分发产物（两件
// we_scene_wasm + quickjs.wasm）的 sha256/大小、构建命令。`scripts/check-release.mjs` 在发布前
// 断言产物与清单一致、且 wasm/src 未在清单之后改动。
//
// 用法：node scripts/gen-wasm-manifest.mjs        # 重建清单（产物变了/改了 wasm/src 后必须重跑）
// 前提：dist/static/ 三件产物已入库（build:client 的产物）；本脚本不重建 wasm。
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveQuickjsPkgJsonPath, resolveQuickjsWasmPath } from './lib/quickjs-wasm-path.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(REPO, 'dist', 'static', 'WASM_BUILD.json');
// 分发产物（相对仓库根）：两件来自 wasm/pkg（build:client 复制），quickjs 来自 node_modules。
const ARTIFACTS = [
  'dist/static/we_scene_wasm.js',
  'dist/static/we_scene_wasm_bg.wasm',
  'dist/static/quickjs.wasm',
];
// quickjs 源的逻辑标识（写进清单；真实路径随包管理器布局变化，运行期解析见 scripts/lib/quickjs-wasm-path.mjs）
const QUICKJS_SOURCE_ID = '@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm';
const BUILD_COMMAND = 'cd wasm && wasm-pack build --no-opt --target web --release --features cpu-sim';

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

function sha256(p) {
  const abs = isAbsolute(p) ? p : join(REPO, p);
  const buf = readFileSync(abs);
  return { sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
}

// 影响 wasm 产物的源码路径（commit / dirty 都按这组路径判定）
const SOURCE_PATHS = ['wasm/src', 'wasm/Cargo.toml', 'wasm/Cargo.lock'];

// 工具版本：本机/CI 缺工具时记 "unknown"（不阻断清单生成，但 check-release 会对比产物哈希）。
function versionOf(cmd, args = ['--version']) {
  const r = sh(cmd, args);
  if (r.code !== 0) return 'unknown';
  const m = /(\d+\.\d+\.\d+[\w.+-]*)/.exec(r.out);
  return m ? m[1] : r.out.split(/\r?\n/)[0];
}

if (!sh('git', ['rev-parse', '--is-inside-work-tree']).out.includes('true')) {
  console.error('[gen-wasm-manifest] 需要 git 仓库（记录 wasm/src 最后 commit）');
  process.exit(1);
}
const wasmSrcCommit = sh('git', ['log', '-1', '--format=%H', '--', ...SOURCE_PATHS]).out;
if (!/^[0-9a-f]{40}$/.test(wasmSrcCommit)) {
  console.error(`[gen-wasm-manifest] 无法读取 wasm 源码最后 commit：${wasmSrcCommit || '(空)'}`);
  process.exit(1);
}
// 只看影响产物的路径：tests/fixtures 等不影响产物
const wasmSrcDirty = sh('git', ['status', '--porcelain', '--', ...SOURCE_PATHS]).out.length > 0;

const artifacts = {};
for (const rel of ARTIFACTS) {
  if (!existsSync(join(REPO, rel))) {
    console.error(`[gen-wasm-manifest] 缺少 ${rel} —— 先跑 \`pnpm run build:client\` 产出 wasm 三件`);
    process.exit(1);
  }
  artifacts[rel] = sha256(rel);
}

const quickjsPkgJson = resolveQuickjsPkgJsonPath(REPO);
const quickjsVersion = quickjsPkgJson
  ? JSON.parse(readFileSync(quickjsPkgJson, 'utf8')).version
  : 'unknown';
const quickjsWasmAbs = resolveQuickjsWasmPath(REPO);
const quickjsSrc = quickjsWasmAbs ? sha256(quickjsWasmAbs) : null;

const manifest = {
  // 溯源文件的语义版本（字段变化时 +1），与插件版本无关
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  buildCommand: BUILD_COMMAND,
  toolchain: {
    rustc: versionOf('rustc'),
    cargo: versionOf('cargo'),
    wasmPack: versionOf('wasm-pack'),
  },
  source: {
    // 产物对应的 wasm 源码基线：wasm/src 的最后改动 commit。wasm/src 之后再改动 ⇒ check-release 红。
    wasmSrcCommit,
    wasmSrcDirty,
  },
  quickjs: {
    version: quickjsVersion,
    source: QUICKJS_SOURCE_ID,
    // 源文件哈希（build:client 直接复制）：源与目的哈希应相同
    sha256: quickjsSrc ? quickjsSrc.sha256 : null,
  },
  artifacts,
};

writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`[gen-wasm-manifest] 已写入 ${MANIFEST}`);
console.log(`  wasm/src commit = ${wasmSrcCommit}${wasmSrcDirty ? '（脏，提交后再生成一次）' : ''}`);
console.log(`  工具链 = rustc ${manifest.toolchain.rustc} / cargo ${manifest.toolchain.cargo} / wasm-pack ${manifest.toolchain.wasmPack}`);
for (const [rel, info] of Object.entries(artifacts)) {
  console.log(`  ${rel}  ${info.size} B  sha256=${info.sha256.slice(0, 16)}…`);
}
if (wasmSrcDirty) {
  console.error('[gen-wasm-manifest] 注意：wasm/src 当前有未提交改动 ⇒ 清单记录的是脏基线，发布前必须提交并重跑');
}
