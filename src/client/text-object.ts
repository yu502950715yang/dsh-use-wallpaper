// src/client/text-object.ts —— WE text 对象文本渲染（T3.1 静态 + T3.3 时钟驱动 + 脚本驱动）
// 把文本绘制到离屏 canvas（2D），包装为 THREE.CanvasTexture 供 quad 贴图。
// 时钟/脚本走字**就地重绘同一 canvas**（不重建纹理）；文本变化时画布按新文本重算，
// 调用方从 driver.layout 取新尺寸并同步 quad（见 threejs-player 帧循环）。
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

// WE text 的限宽布局字段（F12）：limitwidth=true 且 maxwidth 有限正数时按词换行。
export interface TextLayoutOptions {
  limitwidth?: boolean;
  maxwidth?: number;                // 限宽（字体像素，与 measureText 推进宽同空间；单位待真机确认）
}

export interface TextTextureOptions extends TextMeasureOptions {
  color?: [number, number, number]; // 文本颜色（0-255，WE color 的前 3 通道）
  brightness?: number;              // 亮度系数（缺省 1；>1 用叠加绘制近似，见 drawTextToCanvas）
  width: number;                    // 画布宽（= measureTextLayout 实测文本 + 2×padding）
  height: number;                   // 画布高
  verticalAlign?: string;           // WE verticalalign（只影响图层定位，不影响画布内绘制）
  alignment?: string;               // 9 种对齐锚点（halign/valign 缺省时由它推导）
}

export interface TextMeasureOptions extends TextLayoutOptions {
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
  // WE 的 `systemfont_<family>` 别名要按 **basename** 判：scene.json 里存在 `fonts/systemfont_arial`
  // 这种带目录前缀的写法（OWE SceneTextObjectParser.cpp:290-292 的 is_systemfont 同判据），
  // 否则会被下面的「含 '/' ⇒ 字体文件路径」规则吞掉、退成 sans-serif。
  const base = (name.split(/[/\\]/).pop() ?? name).toLowerCase();
  const sys = WE_SYSTEM_FONTS[base];
  if (sys) return sys;
  if (base.startsWith('systemfont_')) return 'sans-serif';
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

// canvas 的字体 bounding box ≈ FreeType 的 ascender/descender/行高。但**pkg 内自定义字体会返回
// 远超 em 的值**（2937346640 的 8bitOperator 实测 ~2.9em ⇒ 画布被撑大 2.4 倍）→ 总行高超过
// 1.5em 时等比收口到 1.2em（与该作者 size 反算出的 396px 一致）。缺失（jsdom mock）→ 0.8/0.2em。
function lineMetrics(ctx: CanvasRenderingContext2D, px: number): { ascent: number; descent: number; lineHeight: number } {
  const m = ctx.measureText('Mg');
  const rawAscent = Number.isFinite(m.fontBoundingBoxAscent) && m.fontBoundingBoxAscent > 0
    ? m.fontBoundingBoxAscent
    : px * 0.8;
  const rawDescent = Number.isFinite(m.fontBoundingBoxDescent) && m.fontBoundingBoxDescent > 0
    ? m.fontBoundingBoxDescent
    : px * 0.2;
  const total = rawAscent + rawDescent;
  const k = total > px * 1.5 ? (px * 1.2) / total : 1;
  return { ascent: rawAscent * k, descent: rawDescent * k, lineHeight: total * k };
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

// 限宽阈值（font 像素）：limitwidth=true 且 maxwidth 有限正数才启用；0 = 不换行。
function wrapWidthOf(opts: TextLayoutOptions): number {
  if (opts.limitwidth !== true) return 0;
  const w = opts.maxwidth;
  return typeof w === 'number' && isFinite(w) && w > 0 ? w : 0;
}

// 按词贪心换行（WE limitwidth 语义）：行宽 ≤ maxWidth；单行本来不超宽时原样保留（不归一化空格）。
// 单个词超宽时独占一行（不切词）。
function wrapLines(lines: string[], maxWidth: number, measure: (s: string) => number): string[] {
  if (maxWidth <= 0) return lines;
  const out: string[] = [];
  for (const line of lines) {
    if (measure(line) <= maxWidth) { out.push(line); continue; }
    let cur = '';
    for (const word of line.split(' ')) {
      const next = cur === '' ? word : `${cur} ${word}`;
      if (cur !== '' && measure(next) > maxWidth) {
        out.push(cur);
        cur = word;
      } else {
        cur = next;
      }
    }
    out.push(cur);
  }
  return out;
}

// brightness 归一：非法（NaN/Infinity/负数）按 1；上限 4 是防御性 clamp（非 WE 语义，
// LDR 下白字叠加 >4 已无法区分），避免病态数据狂刷叠加绘制。
function brightnessOf(v: number | undefined): number {
  if (typeof v !== 'number' || !isFinite(v) || v < 0) return 1;
  return Math.min(4, v);
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// 实测文本布局（OME TextLayouter::SetText）：行宽 = measureText 推进宽，宽取最长行；
// 高 = ascender + descender + (行数-1) × 行高；画布 = 文本 + 2×padding（四边等量）。
export function measureTextLayout(text: string, opts: TextMeasureOptions = {}): TextLayout {
  const pad = paddingOf(opts.padding);
  const ctx = measureContext();
  if (!ctx) {
    // 无 2D 上下文（jsdom 未装 node-canvas）→ 按字号/行长估算，绝不退化成 0 尺寸画布
    const px = fontPx(opts.pointsize);
    const estimate = (s: string) => s.length * px * 0.5;
    const lines = wrapLines(splitLines(text), wrapWidthOf(opts), estimate);
    const longest = lines.reduce((n, l) => Math.max(n, l.length), 2);
    return {
      textWidth: px * 0.5 * longest,
      textHeight: px * lines.length,
      width: Math.max(1, Math.ceil(px * 0.5 * longest + 2 * pad)),
      height: Math.max(1, Math.ceil(px * lines.length + 2 * pad)),
    };
  }
  ctx.font = fontCss(opts.font, opts.pointsize);
  const measure = (line: string) => {
    const w = ctx.measureText(line).width;
    return isFinite(w) ? w : 0;
  };
  const lines = wrapLines(splitLines(text), wrapWidthOf(opts), measure);
  const widths = lines.map(measure);
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

// WE text 的 9 种动态锚点 → halign/valign（`none` 不在表内 = 不覆盖，回退 horizontalalign 族）。
const WE_TEXT_ANCHORS: Record<string, TextAlignments> = {
  center: { halign: 'center', valign: 'center' },
  top: { halign: 'center', valign: 'top' },
  topright: { halign: 'right', valign: 'top' },
  right: { halign: 'right', valign: 'center' },
  bottomright: { halign: 'right', valign: 'bottom' },
  bottom: { halign: 'center', valign: 'bottom' },
  bottomleft: { halign: 'left', valign: 'bottom' },
  left: { halign: 'left', valign: 'center' },
  topleft: { halign: 'left', valign: 'top' },
};

// OME SceneTextObjectParser::align_or_default：horizontalalign/verticalalign 非空时优先；
// 缺省时从 alignment 里找 left/right（vertical 找 top/bottom），找不到即 center。
// v0.8.2 F12：anchor（9 值）非 none 时**优先于** alignment 族；none/未知值走回退。
export function textAlignments(
  horizontalAlign?: string,
  verticalAlign?: string,
  alignment?: string,
  anchor?: string,
): TextAlignments {
  const anchored = typeof anchor === 'string' ? WE_TEXT_ANCHORS[anchor.trim().toLowerCase()] : undefined;
  if (anchored) return { ...anchored };
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
  anchor?: string,
): [number, number] {
  const { halign, valign } = textAlignments(horizontalAlign, verticalAlign, alignment, anchor);
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
// F12：limitwidth/maxwidth 与 measureTextLayout 同规则换行；brightness 用颜色调制 + 叠加近似。
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
  ctx.textBaseline = 'alphabetic';
  const pad = paddingOf(opts.padding);
  // 行内对齐只看 horizontalalign/alignment 族；anchor 决定 quad 原点（见 textLayerOffset）。
  const { halign } = textAlignments(opts.horizontalAlign, opts.verticalAlign, opts.alignment);
  const { ascent, lineHeight } = lineMetrics(ctx, px);
  const measure = (line: string) => {
    const w = ctx.measureText(line).width;
    return isFinite(w) ? w : 0;
  };
  // F12：与 measureTextLayout 同一换行规则（画布尺寸由装配期实测，重绘仍按同一 maxwidth）
  const lines = wrapLines(splitLines(text), wrapWidthOf(opts), measure);
  // 行锚点按 halign：left → 文本框左缘（padding），center → 画布中心，right → 右缘；
  // textAlign 直接用 halign，避免再按行宽换算起点（padding 对称 ⇒ 文本框居中于画布）。
  ctx.textAlign = halign;
  const anchorX = halign === 'left' ? pad : halign === 'right' ? width - pad : width / 2;
  const drawLines = () => {
    lines.forEach((line, i) => {
      ctx.fillText(line, anchorX, pad + ascent + i * lineHeight);
    });
  };
  // F12 brightness = 颜色乘系数（spec §3）：<1 直接压暗颜色；>1 再以 lighter 叠加同一字形近似增亮
  // （白字 rgb 已饱和，叠加是唯一能表达 >1 的 canvas 路径）。绘制后复位合成状态，同一 ctx 可复用。
  const b = brightnessOf(opts.brightness);
  const rgb = opts.color ?? [255, 255, 255];
  const base = rgb.map((c) => clampByte(c * Math.min(b, 1)));
  ctx.fillStyle = b === 1 && !opts.color ? '#ffffff' : `rgb(${base.join(', ')})`;
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  drawLines();
  if (b > 1) {
    const extra = b - 1;
    const passes = Math.ceil(extra);
    ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < passes; i++) {
      ctx.globalAlpha = Math.min(1, extra - i);
      drawLines();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
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
  /** 最近一次文本的实测布局；文本变化后调用方据此同步 quad 尺寸与锚点偏移。 */
  readonly layout: TextLayout;
}

// 文本驱动公共实现（clock 与脚本同路径）：文本变化 → 按**新文本**重算布局 → 重设画布宽高
// 并重绘（drawTextToCanvas 会重设 canvas 尺寸）→ 更新对外 layout。
// 构造期**不**重绘：装配期已按 initialText 画过，重设 canvas 宽高会把已画内容清空；
// 只按 initialText 实测一次布局（与装配期同口径，供调用方对齐）。
function createTextDriver(
  canvas: HTMLCanvasElement,
  opts: TextTextureOptions,
  nextText: (now: Date) => string | null,
  initialText: string,
): ClockDriver {
  const drawOpts = { ...opts };
  let layout = measureTextLayout(initialText, drawOpts);
  let last = initialText;
  return {
    get layout(): TextLayout {
      return layout;
    },
    update(now: Date): boolean {
      const text = nextText(now);
      if (text === null || text === last) return false;
      layout = measureTextLayout(text, drawOpts);
      drawTextToCanvas(canvas, text, { ...drawOpts, width: layout.width, height: layout.height });
      last = text;
      return true;
    },
  };
}

// 脚本驱动：每帧问脚本要新文本，变化才重绘（与 clock 驱动同形态，忽略 now）。
// initialText = 装配期已画进 canvas 的脚本首帧值（避免首帧以相同文本重绘一次）。
export function createScriptDriver(
  canvas: HTMLCanvasElement,
  opts: TextTextureOptions,
  binding: TextScriptBinding,
  initialText = '',
): ClockDriver {
  return createTextDriver(canvas, opts, () => binding.update(), initialText);
}

// 时钟驱动：按 formatClockText 生成文本，**文本变化才重绘**（同分钟不重绘）。
export function createClockDriver(
  canvas: HTMLCanvasElement,
  opts: TextTextureOptions,
  props: Record<string, unknown>,
  initialText: string,
): ClockDriver {
  return createTextDriver(canvas, opts, (now) => formatClockText(now, props), initialText);
}
