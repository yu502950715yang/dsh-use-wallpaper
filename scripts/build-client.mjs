import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// Task 9（@webgpu/glslang 浏览器打包）：@webgpu/glslang 的包入口是 dist/node-devel
// （Emscripten Node 版，运行读 fs/path/__dirname/process），在浏览器 bundle 会报
// "Could not resolve fs/path"。改指向 dist/web-devel 构建（含 export default 的异步
// 工厂 + .wasm asset，Emscripten web 版用 fetch 异步加载 wasm）。
//   - alias：把 `@webgpu/glslang` 直接重定向到 web-devel 的 glslang.js。
//   - loader：.wasm 作为 asset 处理（file loader）。本工程实际靠下方 fs 复制把
//     glslang.wasm 放到 dist/static/，loader 在此仅为「若图里 import 了 .wasm 则按
//     asset 产出」的安全兜底。
//   - glslang-web-patch 插件：web-devel 工厂的 locateFile() 硬编码 `import.meta.url`
//     定位 .wasm，而本 bundle 是 CJS（import.meta 为空对象 → 运行 TypeError）。改为读
//     globalThis.__DSH_GLSLANG_BASE__（由 glsl-to-naga 侧设 /wallpapers/static/），从而
//     在 DSH 插件静态路由下正确 fetch glslang.wasm（与 we_scene_wasm_bg.wasm 一致）。
const GLSLANG_WEB = join(here, '..', 'node_modules', '@webgpu', 'glslang', 'dist', 'web-devel', 'glslang.js');
const glslangWebPlugin = {
  name: 'glslang-web-patch',
  setup(build) {
    build.onLoad({ filter: /web-devel[\\/]glslang\.js$/ }, (args) => {
      let src = readFileSync(args.path, 'utf8');
      // ① locateFile()：web-devel 工厂用 `import.meta.url` 定位 .wasm，而本 bundle 是 CJS
      //   （import.meta 为空对象 → 运行 TypeError）。改为读 globalThis.__DSH_GLSLANG_BASE__。
      src = src.replace(
        /locateFile\(\)\s*\{[\s\S]*?\}/,
        "locateFile(p) {\n" +
          "          const base = (typeof globalThis !== 'undefined' && globalThis.__DSH_GLSLANG_BASE__) || '';\n" +
          "          return base + (p || 'glslang.wasm');\n" +
          "        }",
      );
      // ② web-devel 是双模文件（同时含 `module.exports = Module` 的 CJS 分支 + `export default`）。
      //   esbuild CJS 输出会真实提供 module/exports，使 `module.exports = Module` 分支执行，
      //   覆盖 ESM 命名空间（default），运行时报
      //   "failed to apply loader entry ... cannot set property compileGLSLZeroCopy without provide"。
      //   移除该 CJS/AMD 导出块（仅保留 ESM default），由 esbuild 做 ESM→CJS 转换。
      src = src.replace(
        /if \(typeof exports === 'object' && typeof module === 'object'\)[\s\S]*?exports\["Module"\] = Module;\s*/,
        '// web-devel 的 CJS/AMD 导出已由 build-client.mjs 移除（仅保留 ESM default，避免覆盖命名空间）\n',
      );
      return { contents: src, loader: 'js' };
    });
  },
};

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
  alias: { '@webgpu/glslang': GLSLANG_WEB },
  loader: { '.wasm': 'file' },
  plugins: [glslangWebPlugin],
});

const mainOut = result.outputFiles.find((f) => f.path.endsWith('client.js'));
if (!mainOut) throw new Error('esbuild 未产出 client.js');
writeFileSync('dist/client.js', WRAP_HEAD + mainOut.text + WRAP_TAIL);

const mapOut = result.outputFiles.find((f) => f.path.endsWith('client.js.map'));
if (mapOut) writeFileSync('dist/client.js.map', mapOut.text);

console.log('client bundle written to dist/client.js (external: ' + EXTERNAL.join(', ') + ')');

// Task 8：把 wasm 引擎产物（wasm/pkg/）复制到 dist/static/，由 host 的
// /wallpapers/static/<file> 路由服务（src/host/routes.ts）。wasm-renderer 运行时
// 直接动态 import 入口（we_scene_wasm.js）并调用其默认导出 __wbg_init(wasmUrl)
// 初始化——产物是 wasm-bindgen --target web 格式（单文件 glue + 独立 .wasm，
// 入口内 import.meta.url 定位 wasm，默认导出即初始化函数）。
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

// Task 9（@webgpu/glslang 浏览器打包）：把 web-devel 的 glslang.wasm 复制到 dist/static/，
// 由 host 的 /wallpapers/static/glslang.wasm 路由服务。web-devel 工厂的 locateFile() 经
// glslang-web-patch 插件改为读 globalThis.__DSH_GLSLANG_BASE__（= /wallpapers/static/），
// 运行时 fetch 本文件；与 we_scene_wasm_bg.wasm 走同一静态路由，MIME 为 application/wasm。
const GLSLANG_WASM_SRC = join(here, '..', 'node_modules', '@webgpu', 'glslang', 'dist', 'web-devel', 'glslang.wasm');
if (existsSync(GLSLANG_WASM_SRC)) {
  copyFileSync(GLSLANG_WASM_SRC, join(outStatic, 'glslang.wasm'));
  console.log('glslang.wasm copied to dist/static/ (@webgpu/glslang web-devel)');
} else {
  console.warn(`[build:client] 未找到 ${GLSLANG_WASM_SRC}，跳过 glslang.wasm 复制（真实效果 shader 编译链不可用）`);
}

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
