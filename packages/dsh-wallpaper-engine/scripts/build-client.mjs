import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/client.js',
  external: [],
  sourcemap: true,
});
console.log('client bundle written to dist/client.js');

// Task 8：把 wasm 引擎产物（wasm/pkg/）复制到 dist/static/，由 host 的
// /wallpapers/static/<file> 路由服务（src/host/routes.ts）。wasm-renderer 运行时
// 直接动态 import 入口（we_scene_wasm.js）并调用其默认导出 __wbg_init(wasmUrl)
// 初始化——产物是 wasm-bindgen --target web 格式（单文件 glue + 独立 .wasm，
// 入口内 import.meta.url 定位 wasm，默认导出即初始化函数）。
const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = join(here, '..', 'wasm', 'pkg');
const outStatic = join(here, '..', 'dist', 'static');

// 构建顺序守卫（M54）：dist/static 复制的是 wasm/pkg/ 产物——改过 Rust 必须先
// `npm run build:wasm` 再 build:client，否则页面加载的是旧 wasm。pkg 产物缺失
// （全新克隆 / 未构建）时直接报错并提示，不静默失败在半路。
for (const file of ['we_scene_wasm.js', 'we_scene_wasm_bg.wasm']) {
  if (!existsSync(join(pkgDir, file))) {
    console.error(`[build:client] 缺少 wasm/pkg/${file} —— 请先运行 npm run build:wasm（cd wasm && wasm-pack build --target web --release --features render）`);
    process.exit(1);
  }
}

mkdirSync(outStatic, { recursive: true });
for (const file of ['we_scene_wasm.js', 'we_scene_wasm_bg.wasm']) {
  copyFileSync(join(pkgDir, file), join(outStatic, file));
}
console.log('wasm assets copied to dist/static/ (we_scene_wasm.js, we_scene_wasm_bg.wasm)');
