// src/client/text-object.ts —— WE text 对象静态文本渲染（T3.1）
// 把文本绘制到离屏 canvas（2D），包装为 THREE.CanvasTexture 供 quad 贴图。
// 仅处理静态文本（text.value 直用）；脚本驱动的动态文本（时钟等）见 T3.3。
import * as THREE from 'three';

export interface TextTextureOptions {
  font?: string;                    // WE 字体名（可能是文件路径，如 fonts/Atami-Regular.otf）
  pointsize?: number;               // 字号（WE pointsize，绘制按 px 近似）
  color?: [number, number, number]; // 文本颜色（0-255，WE color 的前 3 通道）
  width: number;                    // 画布宽（= 对象 size 宽；缺省由 textCanvasSize 估算）
  height: number;                   // 画布高
}

// WE 字体名可能是字体文件路径（fonts/xxx.otf）或字体家族名；浏览器无法用文件路径
// 直接绘制，含路径分隔符/扩展名的一律回退默认无衬线字体（设计 A5：字体加载失败回退
// 系统 sans-serif；字体加载管线不在本任务范围）。
function resolveFontFamily(font: string | undefined): string {
  if (typeof font !== 'string' || !font.trim()) return 'sans-serif';
  const name = font.trim();
  if (/[/\\]/.test(name) || /\.[a-zA-Z0-9]{2,4}$/.test(name)) return 'sans-serif';
  return name;
}

// 缺省画布尺寸（T3.1）：text 对象通常带 size 字段（WE 像素）；缺失时按字号与文本
// 长度估算，避免 0 尺寸退化画布或长文本被画布边界裁切。返回取整后非零尺寸。
export function textCanvasSize(
  text: string,
  pointsize: number | undefined,
  size?: [number, number],
): { w: number; h: number } {
  if (size) return { w: Math.max(1, Math.round(size[0])), h: Math.max(1, Math.round(size[1])) };
  const ps = Math.max(1, pointsize ?? 32);
  return {
    w: Math.max(32, Math.ceil(ps * Math.max(text.length, 2) * 0.62)),
    h: Math.max(16, Math.ceil(ps * 1.4)),
  };
}

// 把文本绘制到指定尺寸的离屏 canvas，返回 CanvasTexture（needsUpdate 已置位）。
// 文本水平/垂直居中（静态渲染中心对齐足够；alignment 字段暂不参与布局）。
// canvas 2D 不可用（极端环境/jsdom 无 node-canvas）时返回空白纹理，不抛错。
export function createTextTexture(text: string, opts: TextTextureOptions): THREE.CanvasTexture {
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const size = Math.max(1, opts.pointsize ?? Math.round(height * 0.8));
    // M29：多词字体家族名（如 "Times New Roman"）在 CSS font 简写中必须加引号，
    // 否则整段 font 被浏览器视为非法而静默回退默认字体（单词家族不受影响）。
    const family = resolveFontFamily(opts.font);
    ctx.font = family.includes(' ') ? `${size}px "${family}"` : `${size}px ${family}`;
    ctx.fillStyle = opts.color ? `rgb(${opts.color[0]}, ${opts.color[1]}, ${opts.color[2]})` : '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}
