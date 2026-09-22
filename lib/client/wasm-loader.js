// 静态资源前缀与文件名（与 src/host/routes.ts 的 /wallpapers/static 路由对应；
// scripts/build-client.mjs 从 wasm/pkg/ 复制这两个文件到 dist/static/）
const STATIC_BASE = '/wallpapers/static';
const WASM_GLUE_FILE = 'we_scene_wasm.js';
const WASM_BIN_FILE = 'we_scene_wasm_bg.wasm';
// 加载并初始化 wasm 引擎；失败返回 null（调用方跳过粒子层，不阻断渲染）。
// 必须显式调用默认导出 __wbg_init：wasm 是惰性单例，不调则模块内 wasm 未定义。
// 直接动态 import 静态 URL（不用 blob：blob 无路径基准，入口内 import.meta.url 无法相对定位 wasm）。
export async function defaultLoadWasm() {
    try {
        const mod = (await import(/* @vite-ignore */ `${STATIC_BASE}/${WASM_GLUE_FILE}`));
        await mod.default(`${STATIC_BASE}/${WASM_BIN_FILE}`);
        return mod;
    }
    catch {
        return null;
    }
}
