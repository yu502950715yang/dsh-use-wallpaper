// 研究用 stub（不入 git）：
// lib/client 里 wasm-renderer.js → shader/glsl-to-naga.js **静态 import** 了 `@webgpu/glslang`，
// 而该包的入口指向 dist/node-devel（Emscripten Node 版，require fs/path），esbuild 打包到
// 浏览器会报 "Could not resolve fs/path"（生产 scripts/build-client.mjs 用 alias 指向
// web-devel 解决）。本 harness 走的是 **three 主路径**，完全不需要 GLSL→SPIR-V 编译
// （那是 wasm 路径 glslToNagaPass 才用的），因此把它别名到本 stub：能打包，且一旦真的被
// 调用就立刻抛错——不静默给出错误结果。
export default async function glslangStubInit() {
  throw new Error('[research] @webgpu/glslang 在本 harness 中被 stub：three 主路径不应调用它');
}
export function compileGLSL() {
  throw new Error('[research] @webgpu/glslang stub: compileGLSL 不应被调用');
}
