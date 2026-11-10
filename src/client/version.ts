// 插件版本号：构建期由 scripts/build-client.mjs 的 esbuild define 注入（= package.json version）。
// 未注入环境（vitest / 源码直跑）回退 '0.0.0-dev'，不抛错。
declare const __PLUGIN_VERSION__: string;

export const PLUGIN_VERSION: string = typeof __PLUGIN_VERSION__ === 'string' ? __PLUGIN_VERSION__ : '0.0.0-dev';
