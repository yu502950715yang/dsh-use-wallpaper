// src/client/scene-script.ts —— SceneScript 运行时纯逻辑层（T3，纯逻辑部分）
// 与 quickjs 解耦，node 可测：本模块只做对象状态装配（buildInitialObjectState）
// 与读回规范化（normalizeReadback）两个纯函数；quickjs 绑定层、wasm-renderer
// 消费这些接口。MVP 仅处理 image 对象的脚本动画。后续任务（T4）在同一文件追加
// quickjs 绑定层。import 仅限纯逻辑，不得引入 quickjs / wasm。

export interface ScriptObjectState {
  origin: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  alpha: number;
  image: { alpha: number; brightness: number };
}

export interface ScriptReadback {
  origin?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  imageAlpha?: number;
  imageBrightness?: number;
}

// 构造 QuickJS 可注入的初始对象状态：origin/scale 由三元组拆成 {x,y,z}，
// image.alpha 复用对象级 alpha，image.brightness 取传入亮度。
export function buildInitialObjectState(
  origin: [number, number, number],
  scale: [number, number, number],
  alpha: number,
  brightness: number,
): ScriptObjectState {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    scale: { x: scale[0], y: scale[1], z: scale[2] },
    alpha,
    image: { alpha, brightness },
  };
}

// 规范化读回：clamp alpha 0-1；仅有值字段输出；origin/scale 缺省保留
export function normalizeReadback(raw: {
  origin?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  imageAlpha?: number;
  imageBrightness?: number;
}): ScriptReadback {
  const rb: ScriptReadback = {};
  if (raw.origin) rb.origin = { x: raw.origin.x, y: raw.origin.y, z: raw.origin.z };
  if (raw.scale) rb.scale = { x: raw.scale.x, y: raw.scale.y, z: raw.scale.z };
  if (raw.imageAlpha !== undefined) rb.imageAlpha = Math.max(0, Math.min(1, raw.imageAlpha));
  if (raw.imageBrightness !== undefined) rb.imageBrightness = raw.imageBrightness;
  return rb;
}
