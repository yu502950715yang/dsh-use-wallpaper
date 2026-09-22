import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// 单包化后 dist 可能未预先存在（全新克隆），先确保目录，否则 writeFileSync('dist/client.js') 报 ENOENT
mkdirSync('dist', { recursive: true });

// 2026-08-21（设置面板集成）：client 依赖 DSH 共享模块（React、react-dom 等），
// 构建时标记 external，产物保留 require(...) 调用——运行时由
// window.__ModuleLoader__ 的 factory(require) 解析（与官方 client 插件一致）。
const EXTERNAL = [
  'react',
  'react-dom',
  'react/jsx-runtime',
];

// DSH client 插件 bundle 形态：window.__ModuleLoader__.load({ id, factory })，
// factory 接收同步 require；module/exports 在 factory 作用域内定义，
// esbuild CJS 产物的 module.exports 赋值即模块导出。
const WRAP_HEAD = `window.__ModuleLoader__.load({
\tid: '@dsh-use/wallpaper-engine',
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
`;
const WRAP_TAIL = `
\t\treturn module.exports;
\t}
});
`;

// 2026-09-22：`@webgpu/glslang` 的打包适配（alias + glslang-web-patch + glslang.wasm 复制）
// 已随未接入的 WebGPU 渲染路径（src/client/shader/glsl-to-naga.ts）一起删除 —— 主路径不再需要它。
const result = await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/client.js',
  external: EXTERNAL,
  write: false,
  sourcemap: true,
});

const mainOut = result.outputFiles.find((f) => f.path.endsWith('client.js'));
if (!mainOut) throw new Error('esbuild 未产出 client.js');
writeFileSync('dist/client.js', WRAP_HEAD + mainOut.text + WRAP_TAIL);

const mapOut = result.outputFiles.find((f) => f.path.endsWith('client.js.map'));
if (mapOut) writeFileSync('dist/client.js.map', mapOut.text);

console.log('client bundle written to dist/client.js (external: ' + EXTERNAL.join(', ') + ')');

// 把 wasm 引擎产物（wasm/pkg/）复制到 dist/static/，由 host 的 /wallpapers/static/<file> 路由服务。
// 主路径用它加载 CpuParticleSim（纯 CPU 粒子模拟，不需要 WebGPU）。产物是 wasm-bindgen
// --target web 格式（单文件 glue + 独立 .wasm，入口内 import.meta.url 定位 wasm，默认导出即初始化函数）。
const pkgDir = join(here, '..', 'wasm', 'pkg');
const outStatic = join(here, '..', 'dist', 'static');

// 构建顺序守卫（M54）：dist/static 复制的是 wasm/pkg/ 产物——改过 Rust 必须先
// `npm run build:wasm` 再 build:client，否则页面加载的是旧 wasm。pkg 产物缺失
// （全新克隆 / 未构建）时直接报错并提示，不静默失败在半路。
for (const file of ['we_scene_wasm.js', 'we_scene_wasm_bg.wasm']) {
  if (!existsSync(join(pkgDir, file))) {
    console.error(`[build:client] 缺少 wasm/pkg/${file} —— 请先运行 npm run build:wasm（cd wasm && wasm-pack build --target web --release --features cpu-sim）`);
    process.exit(1);
  }
}

mkdirSync(outStatic, { recursive: true });
for (const file of ['we_scene_wasm.js', 'we_scene_wasm_bg.wasm']) {
  copyFileSync(join(pkgDir, file), join(outStatic, file));
}
console.log('wasm assets copied to dist/static/ (we_scene_wasm.js, we_scene_wasm_bg.wasm)');

// text 脚本沙箱（quickjs）：wasm 复制到 dist/static/，运行时用 RELEASE_SYNC 变体 +
// wasmLocation = '/wallpapers/static/quickjs.wasm'。缺失即中止构建
// （否则线上会静默退化成「脚本不执行」，用户看到的是空文本层）。
const QUICKJS_WASM_SRC = join(here, '..', 'node_modules', '@jitl', 'quickjs-wasmfile-release-sync', 'dist', 'emscripten-module.wasm');
if (!existsSync(QUICKJS_WASM_SRC)) {
  throw new Error(`[build:client] 未找到 ${QUICKJS_WASM_SRC}，text 脚本沙箱不可用 —— 构建中止`);
}
copyFileSync(QUICKJS_WASM_SRC, join(outStatic, 'quickjs.wasm'));
console.log(`quickjs.wasm copied to dist/static/ (${(statSync(QUICKJS_WASM_SRC).size / 1024).toFixed(0)} KB)`);

// 2026-09-11：**不再把 WE 内置粒子纹理复制进 dist/static/**。
//
// 这些纹理（fog1 / halo / light_shafts …）是 Wallpaper Engine 的第三方素材，早先按
// 「静态化」方案复制成 `ptex-<斜杠转横线>.tex` 供 client 直接 fetch。代价是它们会被
// `files: ["dist"]` 一并打进 npm 包 —— 实测解包体积 43.2 MB 里有 33.5 MB 是这批纹理
// （245 个文件里 164 个），既无谓放大包体，也不符合 `.gitignore` 里「不再分发第三方素材」的既定意图。
//
// 现在 client（`scene-assets.resolveParticleMaterial`）直接请求 host 路由
// `/wallpapers/particle-texture?name=particle/<路径>`，由 host 从**用户本机**的 WE 安装目录
// `<weAssetsDir>/assets/materials` 读取原始字节（见 `src/host/routes.ts`）。
// 因此本步骤无需任何构建期文件操作。
console.log('particle textures: 不再复制（client 走 /wallpapers/particle-texture 由 host 从 WE 安装目录直读）');
