// src/client/text-object.ts —— WE text 对象文本渲染（T3.1 静态 + T3.3 时钟驱动 + 脚本驱动）
// 把文本绘制到离屏 canvas（2D），包装为 THREE.CanvasTexture 供 quad 贴图。
// 时钟/脚本走字**就地重绘同一 canvas**（只置 needsUpdate），不重建纹理。
//
// 布局语义（对齐参考实现 open-wallpaper-engine 的 SceneTextObjectParser / TextLayouter）：
//   ① 像素字号 = pointsize × 4（TextPointSizeToPx）；② 图层尺寸 = 实测文本 + 2×padding
//   （**不是** scene.json 的 size）；③ origin 是锚点，halign/valign 决定它落在文本框的哪条边，
//   文本按 padding 排布在画布内；④ '\t' 在 WE 里没有字形 ⇒ 零推进。
import * as THREE from 'three';
import { formatClockText } from './script-patterns.js';
import type { TextScriptBinding } from './text-script.js';

// WE pointsize → 像素字号（OME TextPointSizeToPx）：CodeTime 的 pointsize 32 = 128px 字体，
// 其值层 origin.x 与标签右缘实测吻合到 0.4 场景单位（展开成空格/按 32px 都会对不上）。
const POINTSIZE_TO_PX = 4;
// pointsize 缺省（OME wpscene::TextObject::pointsize = 12）
const DEFAULT_POINTSIZE = 12;

export interface TextTextureOptions {
  font?: string;                    // WE 字体名（可能是文件路径，如 fonts/Atami-Regular.otf）
  pointsize?: number;               // 字号（WE pointsize；像素字号 = pointsize × 4）
  color?: [number, number, number]; // 文本颜色（0-255，WE color 的前 3 通道）
  width: number;                    // 画布宽（= measureTextLayout 实测文本 + 2×padding）
  height: number;                   // 画布高
  padding?: number;                 // WE padding（文本四周等量内边距，字体像素单位）
  horizontalAlign?: string;         // WE horizontalalign（行起点/多行对齐）
  verticalAlign?: string;           // WE verticalalign（只影响图层定位，不影响画布内绘制）
  alignment?: string;               // 9 种对齐锚点（halign/valign 缺省时由它推导）
}

export interface TextMeasureOptions {
  font?: string;
  pointsize?: number;
  padding?: number;
  horizontalAlign?: string;
}

export interface TextLayout {
  width: number;                        // 画布尺寸 = 文本框 + 2×padding（≥1）
  height: number;
  textWidth: number;                    // 文本框（不含 padding）：最长行推进宽
  textHeight: number;                   // 文本框高：首行高 + (行数-1) × 行高
}

// WE 字体名可能是字体文件路径（fonts/xxx.otf）或字体家族名；浏览器无法用文件路径
// 直接绘制，含路径分隔符/扩展名的一律回退默认无衬线字体（设计 A5：字体加载失败回退
// 系统 sans-serif；字体加载管线不在本任务范围）。
// WE 的系统字体名（`systemfont_*`，如 CodeTime 用 systemfont_consolas）→ CSS 家族列表。
// 未知的 systemfont_* 回退 sans-serif；家族名本身直用（多词加引号）。
const WE_SYSTEM_FONTS: Record<string, string> = {
  systemfont_arial: 'Arial, Helvetica, sans-serif',
  systemfont_consolas: 'Consolas, "Courier New", monospace',
  systemfont_couriernew: '"Courier New", Courier, monospace',
  systemfont_timesnewroman: '"Times New Roman", Times, serif',
  systemfont_segoeui: '"Segoe UI", Tahoma, sans-serif',
  systemfont_tahoma: 'Tahoma, Geneva, sans-serif',
  systemfont_verdana: 'Verdana, Geneva, sans-serif',
  systemfont_georgia: 'Georgia, serif',
  systemfont_impact: 'Impact, Charcoal, sans-serif',
  systemfont_lucidaconsole: '"Lucida Console", Monaco, monospace',
  systemfont_comicsansms: '"Comic Sans MS", cursive',
};

function resolveFontFamily(font: string | undefined): string {
  if (typeof font !== 'string' || !font.trim()) return 'sans-serif';
  const name = font.trim();
  const sys = WE_SYSTEM_FONTS[name.toLowerCase()];
  if (sys) return sys;
  if (name.toLowerCase().startsWith('systemfont_')) return 'sans-serif';
  if (/[/\\]/.test(name) || /\.[a-zA-Z0-9]{2,4}$/.test(name)) return 'sans-serif';
  return name.includes(' ') ? `"${name}"` : name;
}

// WE pointsize → 像素字号（OME TextPointSizeToPx：round(pointsize×4)，clamp 1..1024）
function fontPx(pointsize: number | undefined): number {
  const raw = typeof pointsize === 'number' && isFinite(pointsize) && pointsize > 0
    ? pointsize
    : DEFAULT_POINTSIZE;
  return Math.min(1024, Math.max(1, Math.round(raw * POINTSIZE_TO_PX)));
}

function fontCss(font: string | undefined, pointsize: number | undefined): string {
  return `${fontPx(pointsize)}px ${resolveFontFamily(font)}`;
}

// 按 \n 分行；'\t' 在 WE/FreeType 里查不到字形（零推进，OME TextLayouter 直接跳过未光栅化
// 的码点）⇒ 直接剔除，展开成空格会凭空多出缩进（CodeTime 的标签列实测依赖这一点）。
function splitLines(text: string): string[] {
  return String(text).split('\n').map((line) => line.replace(/\t/g, ''));
}

// canvas 的字体 bounding box（Chrome/Windows 取 Win 度量）≈ FreeType 的 ascender/descender/行高；
// 缺失（旧浏览器/jsdom mock）→ 按 0.8em / 0.2em 估算。
function lineMetrics(ctx: CanvasRenderingContext2D, px: number): { ascent: number; descent: number; lineHeight: number } {
  const m = ctx.measureText('Mg');
  const ascent = Number.isFinite(m.fontBoundingBoxAscent) && m.fontBoundingBoxAscent > 0
    ? m.fontBoundingBoxAscent
    : px * 0.8;
  const descent = Number.isFinite(m.fontBoundingBoxDescent) && m.fontBoundingBoxDescent > 0
    ? m.fontBoundingBoxDescent
    : px * 0.2;
  return { ascent, descent, lineHeight: ascent + descent };
}

// 度量用的独立 context（不缓存：jsdom 单测按用例 mock getContext，缓存会跨用例串味）。
function measureContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  try {
    return document.createElement('canvas').getContext('2d');
  } catch {
    return null;
  }
}

function paddingOf(padding: number | undefined): number {
  return typeof padding === 'number' && isFinite(padding) && padding > 0 ? padding : 0;
}

// 实测文本布局（OME TextLayouter::SetText）：行宽 = measureText 推进宽，宽取最长行；
// 高 = ascender + descender + (行数-1) × 行高；画布 = 文本 + 2×padding（四边等量）。
export function measureTextLayout(text: string, opts: TextMeasureOptions = {}): TextLayout {
  const pad = paddingOf(opts.padding);
  const ctx = measureContext();
  if (!ctx) {
    // 无 2D 上下文（jsdom 未装 node-canvas）→ 按字号/行长估算，绝不退化成 0 尺寸画布
    const px = fontPx(opts.pointsize);
    const lines = splitLines(text);
    const longest = lines.reduce((n, l) => Math.max(n, l.length), 2);
    return {
      textWidth: px * 0.5 * longest,
      textHeight: px * lines.length,
      width: Math.max(1, Math.ceil(px * 0.5 * longest + 2 * pad)),
      height: Math.max(1, Math.ceil(px * lines.length + 2 * pad)),
    };
  }
  ctx.font = fontCss(opts.font, opts.pointsize);
  const lines = splitLines(text);
  const widths = lines.map((line) => ctx.measureText(line).width);
  const textWidth = widths.reduce((n, w) => Math.max(n, isFinite(w) ? w : 0), 0);
  const { ascent, descent, lineHeight } = lineMetrics(ctx, fontPx(opts.pointsize));
  const textHeight = ascent + descent + Math.max(0, lines.length - 1) * lineHeight;
  return {
    textWidth,
    textHeight,
    width: Math.max(1, Math.ceil(textWidth + 2 * pad)),
    height: Math.max(1, Math.ceil(textHeight + 2 * pad)),
  };
}

// 画布尺寸（缺省 = 实测文本 + 2×padding）。scene.json 的 size 字段不参与 text 图层尺寸。
export function textCanvasSize(text: string, opts: TextMeasureOptions = {}): { w: number; h: number } {
  const m = measureTextLayout(text, opts);
  return { w: m.width, h: m.height };
}

export interface TextAlignments {
  halign: 'left' | 'center' | 'right';
  valign: 'top' | 'center' | 'bottom';
}

// OME SceneTextObjectParser::align_or_default：horizontalalign/verticalalign 非空时优先；
// 缺省时从 alignment 里找 left/right（vertical 找 top/bottom），找不到即 center。
export function textAlignments(
  horizontalAlign?: string,
  verticalAlign?: string,
  alignment?: string,
): TextAlignments {
  const axis = (primary: string | undefined, fallback: string | undefined, neg: string, pos: string) => {
    const src = typeof primary === 'string' && primary.trim() ? primary : fallback;
    if (typeof src === 'string') {
      if (src.includes(neg)) return neg;
      if (src.includes(pos)) return pos;
    }
    return 'center';
  };
  return {
    halign: axis(horizontalAlign, alignment, 'left', 'right') as TextAlignments['halign'],
    valign: axis(verticalAlign, alignment, 'top', 'bottom') as TextAlignments['valign'],
  };
}

// OME SceneTextObjectParser::apply_text_anchor：origin 是**锚点**，halign/valign 决定它落在
// 文本框的哪条边——left → origin 是左缘（中心右移 text_width/2）、bottom → origin 是下缘
// （中心上移 text_height/2）。偏移量用**不含 padding** 的文本框尺寸 × scale。
export function textLayerOffset(
  layout: TextLayout,
  horizontalAlign: string | undefined,
  verticalAlign: string | undefined,
  alignment: string | undefined,
  scale: readonly number[],
): [number, number] {
  const { halign, valign } = textAlignments(horizontalAlign, verticalAlign, alignment);
  const sx = Number.isFinite(scale[0]) ? scale[0] : 1;
  const sy = Number.isFinite(scale[1]) ? scale[1] : 1;
  const ox = halign === 'left' ? 0.5 : halign === 'right' ? -0.5 : 0;
  const oy = valign === 'top' ? -0.5 : valign === 'bottom' ? 0.5 : 0;
  return [ox * layout.textWidth * sx, oy * layout.textHeight * sy];
}

// 把文本绘制到指定 canvas（就地重绘：时钟走字复用同一 canvas/纹理，只需 needsUpdate）。
// 画布尺寸取 opts（装配期由 measureTextLayout 定）；文本按 horizontalalign 定行起点、按
// padding 排布，行基线 = padding + ascent + i × 行高（canvas y 向下）。verticalalign 只决定
// 图层位置（见 textLayerOffset），不影响画布内绘制——画布本身就是文本框 + 四周 padding。
// 2D 上下文不可用时静默留白，不抛错。
export function drawTextToCanvas(canvas: HTMLCanvasElement, text: string, opts: TextTextureOptions): void {
  const width = Math.max(1, Math.round(opts.width));
  const height = Math.max(1, Math.round(opts.height));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const px = fontPx(opts.pointsize);
  // M29：多词字体家族名（如 "Times New Roman"）在 CSS font 简写中必须加引号，
  // 否则整段 font 被浏览器视为非法而静默回退默认字体（单词家族不受影响）。
  // family 已是完整 CSS 家族列表（可能是 `Consolas, "Courier New", monospace`）→ 不再二次加引号。
  ctx.font = `${px}px ${resolveFontFamily(opts.font)}`;
  ctx.fillStyle = opts.color ? `rgb(${opts.color[0]}, ${opts.color[1]}, ${opts.color[2]})` : '#ffffff';
  ctx.textBaseline = 'alphabetic';
  const pad = paddingOf(opts.padding);
  const { halign } = textAlignments(opts.horizontalAlign, opts.verticalAlign, opts.alignment);
  const { ascent, lineHeight } = lineMetrics(ctx, px);
  const lines = splitLines(text);
  // 行锚点按 halign：left → 文本框左缘（padding），center → 画布中心，right → 右缘；
  // textAlign 直接用 halign，避免再按行宽换算起点（padding 对称 ⇒ 文本框居中于画布）。
  ctx.textAlign = halign;
  const anchorX = halign === 'left' ? pad : halign === 'right' ? width - pad : width / 2;
  lines.forEach((line, i) => {
    ctx.fillText(line, anchorX, pad + ascent + i * lineHeight);
  });
}

// 把文本绘制到新建的离屏 canvas，返回 CanvasTexture（needsUpdate 已置位）。
export function createTextTexture(text: string, opts: TextTextureOptions): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  drawTextToCanvas(canvas, text, opts);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export interface ClockDriver {
  /** 文本变化时重绘 canvas 并返回 true（调用方据此置 texture.needsUpdate）。 */
  update(now: Date): boolean;
}

// 脚本驱动：每帧问脚本要新文本，变化才重绘（与 clock 驱动同形态，忽略 now）。
// initialText = 装配期已画进 canvas 的脚本首帧值（避免首帧以相同文本重绘一次）。
export function createScriptDriver(
  canvas: HTMLCanvasElement,
  opts: TextTextureOptions,
  binding: TextScriptBinding,
  initialText = '',
): ClockDriver {
  let last = initialText;
  return {
    update(_now: Date): boolean {
      const text = binding.update();
      if (text === null || text === '' || text === last) return false;
      drawTextToCanvas(canvas, text, opts);
      last = text;
      return true;
    },
  };
}

// 时钟驱动：按 formatClockText 生成文本，**文本变化才重绘**（同分钟不重绘）。
export function createClockDriver(
  canvas: HTMLCanvasElement,
  opts: TextTextureOptions,
  props: Record<string, unknown>,
  initialText: string,
): ClockDriver {
  let last = initialText;
  return {
    update(now: Date): boolean {
      const text = formatClockText(now, props);
      if (text === last) return false;
      drawTextToCanvas(canvas, text, opts);
      last = text;
      return true;
    },
  };
}
