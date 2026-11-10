// 定位 quickjs 沙箱 wasm 源文件（`@jitl/quickjs-wasmfile-release-sync` 的 emscripten module）。
//
// 为什么需要它：`@jitl/*` 不是本项目的顶层依赖（是 quickjs-emscripten 的依赖），
// npm 布局下 `node_modules/@jitl/...` 恰好存在，但 **pnpm 布局下不存在**（包只在
// `node_modules/.pnpm/` 里）⇒ 硬编码顶层路径会 ENOENT，build:client 直接中止。
//
// 解析顺序：
// ① 从 quickjs-emscripten 的解析上下文里 resolve（npm / pnpm / yarn 都可靠）；
// ② 扫 `node_modules/.pnpm/@jitl+quickjs-wasmfile-release-sync@*/`（pnpm 兜底）。
// 返回绝对路径；找不到返回 null（调用方决定 throw 还是降级）。
import { createRequire } from 'node:module';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = '@jitl/quickjs-wasmfile-release-sync';
const REL_WASM = 'dist/emscripten-module.wasm';

export function resolveQuickjsWasmPath(repoRoot) {
  const reqAt = (file) => createRequire(pathToFileURL(file).href);
  try {
    const rootReq = reqAt(join(repoRoot, 'package.json'));
    const viaQuickjs = reqAt(rootReq.resolve('quickjs-emscripten'));
    const resolved = viaQuickjs.resolve(`${PKG}/${REL_WASM}`);
    if (existsSync(resolved)) return resolved;
  } catch {
    // 落到 pnpm 扫描
  }
  const store = join(repoRoot, 'node_modules', '.pnpm');
  try {
    for (const dir of readdirSync(store)) {
      if (!dir.startsWith('@jitl+quickjs-wasmfile-release-sync@')) continue;
      const candidate = join(store, dir, 'node_modules', PKG, REL_WASM);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // node_modules 不存在 / 不是 pnpm 布局
  }
  return null;
}

/** quickjs 源包的 package.json 路径（读版本号用）；找不到返回 null。 */
export function resolveQuickjsPkgJsonPath(repoRoot) {
  const wasm = resolveQuickjsWasmPath(repoRoot);
  if (!wasm) return null;
  const pkgJson = join(wasm, '..', '..', 'package.json');
  return existsSync(pkgJson) ? pkgJson : null;
}
