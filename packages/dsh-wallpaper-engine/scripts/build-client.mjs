import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
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

// 2026-08-21（方案 A 静态化）：WE 内置粒子纹理（fog1/halo/light_shafts 等，粒子材质
// textures 如 "particle/fog/fog1"）从安装目录 assets/materials/particle/ 复制到
// dist/static/，扁平命名 ptex-<路径斜杠转横线>.tex（静态路由仅单段文件名）。
// wasm-renderer 按同名规则 fetch /wallpapers/static/ptex-*.tex——**不依赖 host 新增
// 路由**（/wallpapers/particle-texture 需重启 dsh web 才注册；静态路径立即生效）。
// WE 安装目录可用环境变量 WE_ASSETS_DIR 覆盖（构建机可能不在本机）。
const weAssets = process.env.WE_ASSETS_DIR || 'D:/Steam/steamapps/common/wallpaper_engine';
const weParticleDir = join(weAssets, 'assets', 'materials', 'particle');
let ptexCopied = 0;
if (existsSync(weParticleDir)) {
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.tex')) {
        const rel = p.slice(weParticleDir.length + 1).replace(/[\\/]/g, '-');
        copyFileSync(p, join(outStatic, `ptex-${rel}`));
        ptexCopied++;
      }
    }
  };
  walk(weParticleDir);
}
console.log(`particle textures copied to dist/static/ (${ptexCopied} files, source: ${weParticleDir})`);
