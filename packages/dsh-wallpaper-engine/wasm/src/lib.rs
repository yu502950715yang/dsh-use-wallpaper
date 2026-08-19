pub mod coords;
pub mod particle;
pub mod render;
pub mod scene;
pub mod tex;

/// wasm 渲染运行时初始化（仅 render feature / wasm 构建可用）：
/// 注册 console_error_panic_hook，浏览器里 Rust panic 打印到 console。
/// JS 侧在模块加载后调用一次。
#[cfg(feature = "render")]
pub fn init_wasm_runtime() {
    console_error_panic_hook::set_once();
}
