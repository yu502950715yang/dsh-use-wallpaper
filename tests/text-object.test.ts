// @vitest-environment jsdom
// text 对象渲染：画布尺寸 = measureText 实测文本 + 2×padding（WE/OME 语义，不再取 scene.json
// 的 size 字段）；文本按 horizontalalign/verticalalign 定位到图层锚点。
// jsdom 未实现 canvas 2D（仓库未装 node-canvas，getContext('2d') 默认返回 null），
// 与 tex-loader.test.ts 的 mock 全局思路一致：mock HTMLCanvasElement.prototype.getContext
// 返回记录型 2D 上下文（含 measureText 度量），断言绘制参数与返回纹理的宽高。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import {
  createTextTexture, textCanvasSize, measureTextLayout, drawTextToCanvas, textAlignments,
  textLayerOffset, createClockDriver, createScriptDriver,
} from '../src/client/text-object.js';
import { formatClockText } from '../src/client/script-patterns.js';

// 记录型 2D 上下文：捕获绘制状态与 fillText 调用；度量按「等宽 0.5em、字体 bounding box 1em
// （ascent 0.8em / descent 0.2em）」模拟，便于手算期望值。
function makeMock2d() {
  const ctx = {
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    // F12 brightness 的叠加绘制会改这两个状态（每轮绘制后必须复位）
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillText: vi.fn(),
    measureText: vi.fn((s: string) => {
      const px = parseFloat(ctx.font) || 10;
      return {
        width: String(s).length * px * 0.5,
        fontBoundingBoxAscent: px * 0.8,
        fontBoundingBoxDescent: px * 0.2,
      };
    }),
  };
  return ctx;
}

describe('measureTextLayout / textCanvasSize（画布 = 实测文本 + 2×padding）', () => {
  let ctx: ReturnType<typeof makeMock2d>;

  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // WE 的 pointsize 是「点」，OME TextPointSizeToPx = pointsize × 4 ⇒ CodeTime 的 pointsize 32
  // 是 128px 字体（scene.json 各值层的 origin.x 与标签右缘实测吻合，见 AGENT.md）。
  it('pointsize ×4 为像素字号；画布宽高 = 实测文本 + 2×padding', () => {
    const m = measureTextLayout('abc', { pointsize: 32, padding: 32 });
    expect(ctx.font).toBe('128px sans-serif');
    expect(m.textWidth).toBe(192);        // 3 字 × 0.5em × 128px
    expect(m.textHeight).toBe(128);       // ascent 0.8em + descent 0.2em
    expect(m.width).toBe(256);            // + 2×32
    expect(m.height).toBe(192);
  });

  it('textCanvasSize 与 measureTextLayout 同口径（宽随实测文本变化，不再取 size 字段）', () => {
    expect(textCanvasSize('const', { pointsize: 32, padding: 32 })).toEqual({ w: 5 * 64 + 64, h: 192 });
    expect(textCanvasSize('}', { pointsize: 32, padding: 32 })).toEqual({ w: 64 + 64, h: 192 });
    // 无 padding → 画布 = 文本尺寸本身（pointsize 10 → 40px 字号：'ab' = 2×0.5em×40）
    expect(textCanvasSize('ab', { pointsize: 10 })).toEqual({ w: 40, h: 40 });
  });

  // OME：text_h = ascender - descender + (行数-1) × line_height。
  it('多行：高 = 首行高 + (行数-1)×行高；宽取最长行', () => {
    const m = measureTextLayout('A\nBB\nC', { pointsize: 20, padding: 5 });
    expect(ctx.font).toBe('80px sans-serif');
    expect(m.textWidth).toBe(80);        // 'BB' = 2 × 0.5em × 80px
    expect(m.textHeight).toBe(80 * 3);   // 3 行：80 + 2×80
    expect(m).toMatchObject({ width: 90, height: 250 });
  });

  it('pointsize 缺省 → WE 默认 pointsize 12（48px）', () => {
    measureTextLayout('x', {});
    expect(ctx.font).toBe('48px sans-serif');
  });

  it('2D 上下文不可用 → 按字号估算兜底，不产生退化尺寸', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const m = measureTextLayout('hello', { pointsize: 32, padding: 32 });
    expect(m.width).toBeGreaterThan(64);
    expect(m.height).toBeGreaterThan(64);
    expect(textCanvasSize('', {})).toEqual({ w: expect.any(Number), h: expect.any(Number) });
    expect(textCanvasSize('', {}).w).toBeGreaterThan(0);
    expect(textCanvasSize('', {}).h).toBeGreaterThan(0);
  });
});

describe('drawTextToCanvas（就地重绘：时钟复用同一 canvas 与纹理）', () => {
  let ctx: ReturnType<typeof makeMock2d>;
  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('按 opts 重设画布尺寸（装配期测得的文本 + 2×padding）', () => {
    const canvas = document.createElement('canvas');
    drawTextToCanvas(canvas, '14:05', { pointsize: 40, width: 200, height: 64 });
    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(64);
  });

  // OME TextLayouter：行 x 由 halign 决定（left → 文本框左缘，right → 右缘，center → 居中）；
  // 文本框在画布内的位置由 padding 决定（四周等量）。
  it('horizontalalign → 行锚点与 textAlign：left=padding / center=画布中心 / right=宽-padding', () => {
    const canvas = document.createElement('canvas');
    // pointsize 10 → 40px 字号，ascent 0.8em = 32 → 基线 = padding 20 + 32 = 52
    drawTextToCanvas(canvas, 'ab', { pointsize: 10, width: 200, height: 100, padding: 20, horizontalAlign: 'left' });
    expect(ctx.textAlign).toBe('left');
    expect(ctx.fillText).toHaveBeenLastCalledWith('ab', 20, 52);
    drawTextToCanvas(canvas, 'ab', { pointsize: 10, width: 200, height: 100, padding: 20, horizontalAlign: 'center' });
    expect(ctx.textAlign).toBe('center');
    expect(ctx.fillText).toHaveBeenLastCalledWith('ab', 100, 52);
    drawTextToCanvas(canvas, 'ab', { pointsize: 10, width: 200, height: 100, padding: 20, horizontalAlign: 'right' });
    expect(ctx.textAlign).toBe('right');
    expect(ctx.fillText).toHaveBeenLastCalledWith('ab', 180, 52);
  });

  // 多行按 \n 分行；基线自上而下 = padding + ascent + i × 行高（canvas y 向下）。
  it('多行按 \\n 分行、基线自 padding+ascent 起逐行下移一个行高', () => {
    const canvas = document.createElement('canvas');
    drawTextToCanvas(canvas, 'A\nB\nC', { pointsize: 20, width: 200, height: 300, padding: 8, horizontalAlign: 'left' });
    // 行高 = 80px（ascent 64 + descent 16），行距 = 行高
    expect(ctx.fillText.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ['A', 72], ['B', 152], ['C', 232],
    ]);
  });

  // WE/FreeType 里 '\t' 没有字形 ⇒ 零推进（OME TextLayouter 直接跳过未光栅化的码点）。
  // CodeTime id=59 的标签层靠 \t 缩进，但 scene.json 里各值层的 origin.x 恰好等于**无缩进**
  // 标签的右缘（6/6 吻合到 0.4 场景单位）⇒ 展开成空格会多出 4 字缩进、与桌面不符。
  it('制表符零推进（剔除），不展开成空格', () => {
    const canvas = document.createElement('canvas');
    drawTextToCanvas(canvas, 'hour:\n\t\tminute:', { pointsize: 20, width: 200, height: 100 });
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['hour:', 'minute:']);
  });

  it('字体 bounding box 远超 em（pkg 内自定义字体）→ 行高收口 1.2em，画布不被撑大', () => {
    // 2937346640 的 8bitOperator 实测 ~2.9em；照用会把两行文本的画布撑到 958px（应为 394px）
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue({
      ...ctx,
      font: '164px X',
      measureText: () => ({ width: 100, fontBoundingBoxAscent: 400, fontBoundingBoxDescent: 80 }),
    } as never);
    const layout = measureTextLayout('a\nb', { pointsize: 41 });   // pointsize×4 = 164px
    expect(layout.height).toBeCloseTo(2 * 164 * 1.2, 0);          // 393.6，而非 960
  });

  it('font 为文件路径（fonts/xxx.otf）→ 回退 sans-serif；字体家族名直用；WE 系统字体名映射', () => {
    createTextTexture('x', { font: 'fonts/Atami-Regular.otf', pointsize: 20, width: 100, height: 50 });
    expect(ctx.font).toBe('80px sans-serif');
    createTextTexture('y', { font: 'Arial', pointsize: 24, width: 100, height: 50 });
    expect(ctx.font).toBe('96px Arial');
    createTextTexture('x', { font: 'systemfont_consolas', pointsize: 32, width: 100, height: 50 });
    expect(ctx.font).toBe('128px Consolas, "Courier New", monospace');
    createTextTexture('y', { font: 'systemfont_arial', pointsize: 32, width: 100, height: 50 });
    expect(ctx.font).toBe('128px Arial, Helvetica, sans-serif');
    // 带目录前缀的系统字体别名（WE 里真实存在的写法，如 `fonts/systemfont_arial`）：按 basename 判，
    // 否则会被当字体文件路径回退 sans-serif（OWE SceneTextObjectParser.cpp:290-292 同判据）。
    createTextTexture('y', { font: 'fonts/systemfont_arial', pointsize: 32, width: 100, height: 50 });
    expect(ctx.font).toBe('128px Arial, Helvetica, sans-serif');
    createTextTexture('y', { font: 'fonts/systemfont_consolas', pointsize: 32, width: 100, height: 50 });
    expect(ctx.font).toBe('128px Consolas, "Courier New", monospace');
    // 未知系统字体别名仍回退 sans-serif（不因带前缀就当成家族名）
    createTextTexture('y', { font: 'fonts/systemfont_unknownfamily', pointsize: 32, width: 100, height: 50 });
    expect(ctx.font).toBe('128px sans-serif');
    // M29：多词家族名在 CSS font 简写中必须加引号
    createTextTexture('z', { font: 'Times New Roman', pointsize: 20, width: 100, height: 50 });
    expect(ctx.font).toBe('80px "Times New Roman"');
  });

  it('color [r,g,b] → rgb() fillStyle；缺省白色', () => {
    createTextTexture('x', { color: [255, 0, 128], width: 100, height: 50 });
    expect(ctx.fillStyle).toBe('rgb(255, 0, 128)');
    createTextTexture('x', { width: 100, height: 50 });
    expect(ctx.fillStyle).toBe('#ffffff');
  });

  it('2D 上下文不可用（getContext → null）时不抛错', () => {
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const canvas = document.createElement('canvas');
    expect(() => drawTextToCanvas(canvas, 'x', { width: 10, height: 10 })).not.toThrow();
  });
});

// OME SceneTextObjectParser::align_or_default：horizontalalign/verticalalign 非空优先；
// 缺省时从 alignment 里找 left/right（vertical 找 top/bottom），找不到即 center。
describe('textAlignments（halign/valign 缺省由 alignment 推导）', () => {
  it('horizontalalign/verticalalign 非空时优先', () => {
    expect(textAlignments('left', 'bottom', 'topright')).toEqual({ halign: 'left', valign: 'bottom' });
    expect(textAlignments('center', 'center', 'bottomleft')).toEqual({ halign: 'center', valign: 'center' });
  });

  it('缺省时由 alignment 推导（9 种锚点），都缺省 → center/center', () => {
    expect(textAlignments(undefined, undefined, 'topleft')).toEqual({ halign: 'left', valign: 'top' });
    expect(textAlignments(undefined, undefined, 'bottomright')).toEqual({ halign: 'right', valign: 'bottom' });
    expect(textAlignments(undefined, undefined, 'right')).toEqual({ halign: 'right', valign: 'center' });
    expect(textAlignments(undefined, undefined, 'top')).toEqual({ halign: 'center', valign: 'top' });
    expect(textAlignments(undefined, undefined, 'center')).toEqual({ halign: 'center', valign: 'center' });
    expect(textAlignments(undefined, undefined, undefined)).toEqual({ halign: 'center', valign: 'center' });
  });
});

// OME SceneTextObjectParser::apply_text_anchor：origin 是锚点，halign/valign 决定锚点落在
// 文本框的哪条边——left → origin 是左缘（中心右移 text_width/2）、bottom → origin 是下缘
// （中心上移 text_height/2）；偏移用**不含 padding** 的文本框尺寸 × scale。
describe('textLayerOffset（origin 锚点 → quad 中心偏移）', () => {
  const layout = { width: 528, height: 213, textWidth: 464, textHeight: 149 };

  it('left/bottom → 中心 = origin + (textWidth/2, textHeight/2) × scale', () => {
    expect(textLayerOffset(layout, 'left', 'bottom', undefined, [0.05, 0.05, 1]))
      .toEqual([464 / 2 * 0.05, 149 / 2 * 0.05]);
  });

  it('右/上 → 负向偏移；center → 无偏移（VHS 等居中图层位置不变）', () => {
    expect(textLayerOffset(layout, 'right', 'top', undefined, [0.05, 0.05, 1]))
      .toEqual([-464 / 2 * 0.05, -149 / 2 * 0.05]);
    expect(textLayerOffset(layout, 'center', 'center', undefined, [0.05, 0.05, 1])).toEqual([0, 0]);
  });

  it('halign/valign 缺省时按 alignment 推导（CodeTime 值层 = 无字段 + alignment 形态）', () => {
    expect(textLayerOffset(layout, undefined, undefined, 'left', [1, 1, 1])).toEqual([232, 0]);
    expect(textLayerOffset(layout, undefined, undefined, 'bottomleft', [1, 1, 1])).toEqual([232, 74.5]);
  });
});

describe('createTextTexture', () => {
  let ctx: ReturnType<typeof makeMock2d>;

  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('返回宽高与 opts 一致的 CanvasTexture（画布即纹理 image）', () => {
    const tex = createTextTexture('12:00', { width: 400, height: 100 });
    expect(tex).toBeInstanceOf(THREE.CanvasTexture);
    expect(tex.image).toBeInstanceOf(HTMLCanvasElement);
    expect(tex.image.width).toBe(400);
    expect(tex.image.height).toBe(100);
    // three r170 的 Texture.needsUpdate 是只写 setter（读回 undefined），其可观测
    // 副作用是 version 递增（上传脏标记）——CanvasTexture 构造时已置位
    expect(tex.version).toBeGreaterThan(0);
  });

  it('绘制参数：pointsize×4 字号、缺省 halign=center（画布中心）、基线 = ascent', () => {
    createTextTexture('12:00', { pointsize: 80, width: 400, height: 100 });
    expect(ctx.font).toBe('320px sans-serif');
    expect(ctx.fillStyle).toBe('#ffffff');
    expect(ctx.textAlign).toBe('center');
    expect(ctx.textBaseline).toBe('alphabetic');
    expect(ctx.fillText).toHaveBeenCalledWith('12:00', 200, 256);
  });

  it('canvas 2D 不可用（getContext 返回 null）→ 仍返回空纹理不抛错', () => {
    // 显式 mock 返回 null（等价 jsdom 无 node-canvas 的默认行为，且不触发 jsdom 的
    // "Not implemented" virtual-console 报错噪声）
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const tex = createTextTexture('x', { width: 10, height: 10 });
    expect(tex).toBeInstanceOf(THREE.CanvasTexture);
  });
});

describe('createClockDriver（clock 模式：文本变化才重绘）', () => {
  let ctx: ReturnType<typeof makeMock2d>;
  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('同一分钟返回 false（不重绘），跨分钟返回 true 并重绘', () => {
    const canvas = document.createElement('canvas');
    const driver = createClockDriver(canvas, { pointsize: 40, width: 200, height: 64 }, {}, 'init');
    // clock 文本是两行（`HH:MM\nMon. D YYYY`）→ 每次重绘 2 次 fillText
    expect(driver.update(new Date(2026, 7, 21, 14, 5, 10))).toBe(true);
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
    expect(driver.update(new Date(2026, 7, 21, 14, 5, 50))).toBe(false);
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
    expect(driver.update(new Date(2026, 7, 21, 14, 6, 0))).toBe(true);
    expect(ctx.fillText).toHaveBeenCalledTimes(4);
  });

  it('初始文本就是当前时钟文本 → 首次 update 不重绘（构造即已绘制）', () => {
    const props: Record<string, unknown> = {};
    const now = new Date(2026, 7, 21, 14, 5, 0);
    const canvas = document.createElement('canvas');
    const driver = createClockDriver(canvas, { width: 10, height: 10 }, props, formatClockText(now, props));
    expect(driver.update(now)).toBe(false);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});

describe('createScriptDriver（text.script：脚本给出新文本，变化才重绘）', () => {
  let ctx: ReturnType<typeof makeMock2d>;
  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('脚本文本变化才重绘并返回 true', () => {
    let text = 'a';
    const binding = { update: () => text, dispose: () => {} };
    const canvas = document.createElement('canvas');
    const driver = createScriptDriver(canvas, { width: 10, height: 10 }, binding);
    expect(driver.update(new Date())).toBe(true); // 与初始 '' 不同 → 重绘
    expect(driver.update(new Date())).toBe(false); // 未变
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
    text = 'b';
    expect(driver.update(new Date())).toBe(true);
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });

  it('脚本返回 null（抛错/超时）时不动纹理', () => {
    const binding = { update: (): string | null => null, dispose: () => {} };
    const driver = createScriptDriver(document.createElement('canvas'), { width: 10, height: 10 }, binding);
    expect(driver.update(new Date())).toBe(false);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it('装配期已画过脚本初值 → 传入 initialText 后首帧同值不重绘', () => {
    const binding = { update: () => 'SCRIPTED', dispose: () => {} };
    const canvas = document.createElement('canvas');
    const driver = createScriptDriver(canvas, { width: 10, height: 10 }, binding, 'SCRIPTED');
    expect(driver.update(new Date())).toBe(false);
    expect(ctx.fillText).not.toHaveBeenCalled();
  });
});

// 缺陷（用户截图确认）：画布尺寸只在装配期按首帧文本算一次，首帧之后再没重算 ⇒ 文本变长后
// 超出旧画布、尾部被裁切（2980088441 的 minute 值层：装配期 `09` 2 字符，跨到 10 后 `"10"` 4 字符）。
// 语义对齐 OME SceneTextObjectParser::update_text_layout：文本变化 → 重排 → SetSize(text+2×padding)。
describe('文本变化 → 画布/布局按新文本重算（动态 resize）', () => {
  let ctx: ReturnType<typeof makeMock2d>;
  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  // pointsize 40 → 160px 字号（mock 等宽 0.5em = 80px/字符）；padding 8 → 画布 = 文本宽 + 16
  const OPTS = { pointsize: 40, padding: 8, horizontalAlign: 'center', width: 10, height: 10 };

  it('文本变长：layout 与画布宽按新文本变大，行锚点用新画布宽', () => {
    let text = '09';                       // 2 字符 → 160 + 16 = 176
    const binding = { update: () => text, dispose: () => {} };
    const canvas = document.createElement('canvas');
    const driver = createScriptDriver(canvas, OPTS, binding, text);
    expect(driver.layout).toMatchObject({ textWidth: 160, width: 176 });
    text = '"10"';                         // 4 字符 → 320 + 16 = 336
    expect(driver.update(new Date())).toBe(true);
    expect(driver.layout).toMatchObject({ textWidth: 320, width: 336 });
    expect(canvas.width).toBe(336);
    expect(canvas.height).toBe(176);
    // center 行锚点 = 新画布中心（用装配期的旧宽会画到别处）；基线 = padding + ascent
    expect(ctx.fillText).toHaveBeenLastCalledWith('"10"', 168, 8 + 128);
  });

  it('文本变短：画布随之缩小', () => {
    let text = '"10"';
    const binding = { update: () => text, dispose: () => {} };
    const canvas = document.createElement('canvas');
    const driver = createScriptDriver(canvas, OPTS, binding, text);
    expect(driver.layout.width).toBe(336);
    text = '09';
    expect(driver.update(new Date())).toBe(true);
    expect(driver.layout).toMatchObject({ textWidth: 160, width: 176 });
    expect(canvas.width).toBe(176);
    expect(ctx.fillText).toHaveBeenLastCalledWith('09', 88, 136);
  });

  // clock 驱动与脚本驱动同路径：跨天 9 → 10 日时日期行变长（`Sep. 9 2026` → `Sep. 10 2026`）。
  it('clock 驱动文本变化同样重算画布（不是只置 needsUpdate）', () => {
    const props = { use24hFormat: true, delimiter: ':' };
    const t0 = new Date(2026, 8, 9, 14, 5, 0);
    const canvas = document.createElement('canvas');
    const driver = createClockDriver(canvas, OPTS, props, formatClockText(t0, props));
    // `14:05\nSep. 9 2026`：最长行 11 字符 → 880 + 16；两行高 = 128+32+160 + 16
    expect(driver.layout).toMatchObject({ textWidth: 880, width: 896, textHeight: 320, height: 336 });
    const t1 = new Date(2026, 8, 10, 14, 6, 0);
    expect(driver.update(t1)).toBe(true);
    expect(driver.layout).toMatchObject({ textWidth: 960, width: 976 });
    expect(canvas.width).toBe(976);
    expect(canvas.height).toBe(336);
  });
});

// v0.8.2 F12：limitwidth/maxwidth 限宽换行。mock 等宽 0.5em ⇒ pointsize 10（40px 字号）每字符 20px。
// '20 OCTOBER 2026' 单词宽 40 / 140 / 80；maxwidth 200 ⇒ 第一行 '20 OCTOBER' 恰好 200、'2026' 换行。
describe('limitwidth / maxwidth（超宽按词换行）', () => {
  let ctx: ReturnType<typeof makeMock2d>;
  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('超宽文本按词换行：行数增加，画布高 = 多行高度', () => {
    const m = measureTextLayout('20 OCTOBER 2026', { pointsize: 10, limitwidth: true, maxwidth: 200 });
    expect(m.textWidth).toBe(200);      // 最长行 '20 OCTOBER' = 40 + 20 + 140
    expect(m.textHeight).toBe(80);      // 2 行 × 40px 行高
    expect(m).toMatchObject({ width: 200, height: 80 });
  });

  it('limitwidth 缺省/false 或无 maxwidth → 不换行（旧行为零回归）', () => {
    const raw = { textWidth: 300, textHeight: 40, width: 300, height: 40 };
    expect(measureTextLayout('20 OCTOBER 2026', { pointsize: 10, maxwidth: 200 })).toEqual(raw);
    expect(measureTextLayout('20 OCTOBER 2026', { pointsize: 10, limitwidth: false, maxwidth: 200 })).toEqual(raw);
    expect(measureTextLayout('20 OCTOBER 2026', { pointsize: 10, limitwidth: true })).toEqual(raw);
  });

  it('逐词贪心：每行宽 ≤ maxwidth；单个超宽词独占一行（不切词）', () => {
    const m = measureTextLayout('A BB CCC DDDD', { pointsize: 10, limitwidth: true, maxwidth: 100 });
    // 宽 20 / 40 / 60 / 80：'A BB'=80、+ ' CCC'=160 超 ⇒ 换行；'CCC DDDD'=160 超 ⇒ 再换行
    expect(m.textWidth).toBe(80);
    expect(m.textHeight).toBe(120);
    const long = measureTextLayout('AAAAAAAA', { pointsize: 10, limitwidth: true, maxwidth: 100 });
    expect(long.textWidth).toBe(160);   // 8 × 20 = 160 > 100，但词内不切分
    expect(long.textHeight).toBe(40);
  });

  it('maxwidth 为 0 / 负数 → 不换行（只有有限正数才启用）', () => {
    const raw = { textWidth: 300, textHeight: 40, width: 300, height: 40 };
    expect(measureTextLayout('20 OCTOBER 2026', { pointsize: 10, limitwidth: true, maxwidth: 0 })).toEqual(raw);
    expect(measureTextLayout('20 OCTOBER 2026', { pointsize: 10, limitwidth: true, maxwidth: -100 })).toEqual(raw);
  });

  it('带 padding：maxwidth 只约束行宽（字体像素），画布 = 最长行 + 2×padding', () => {
    const m = measureTextLayout('20 OCTOBER 2026', { pointsize: 10, limitwidth: true, maxwidth: 200, padding: 5 });
    expect(m.textWidth).toBe(200);                        // 换行仍按 maxwidth，不被 padding 收缩
    expect(m).toMatchObject({ width: 210, height: 90 });  // 2 行 × 40 行高 + 2×5
  });

  it('drawTextToCanvas 与 measure 同一换行规则（逐行 fillText）', () => {
    const canvas = document.createElement('canvas');
    drawTextToCanvas(canvas, '20 OCTOBER 2026', {
      pointsize: 10, width: 200, height: 80, limitwidth: true, maxwidth: 200,
    });
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['20 OCTOBER', '2026']);
  });

  it('驱动器重绘沿用 limitwidth（文本变化后仍换行）', () => {
    const binding = { update: () => '20 OCTOBER 2026', dispose: () => {} };
    const canvas = document.createElement('canvas');
    const driver = createScriptDriver(canvas, {
      width: 10, height: 10, pointsize: 10, limitwidth: true, maxwidth: 200,
    }, binding, '');
    expect(driver.update(new Date())).toBe(true);
    expect(driver.layout).toMatchObject({ textWidth: 200, textHeight: 80 });
    expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['20 OCTOBER', '2026']);
  });
});

// v0.8.2 F12：anchor 是 9 种 WE 锚点值（none 表示不覆盖），优先于 alignment 族。
describe('textAlignments(anchor) / textLayerOffset(anchor)（F12）', () => {
  it('9 种 anchor → halign/valign', () => {
    const cases: Array<[string, { halign: string; valign: string }]> = [
      ['center', { halign: 'center', valign: 'center' }],
      ['top', { halign: 'center', valign: 'top' }],
      ['topright', { halign: 'right', valign: 'top' }],
      ['right', { halign: 'right', valign: 'center' }],
      ['bottomright', { halign: 'right', valign: 'bottom' }],
      ['bottom', { halign: 'center', valign: 'bottom' }],
      ['bottomleft', { halign: 'left', valign: 'bottom' }],
      ['left', { halign: 'left', valign: 'center' }],
      ['topleft', { halign: 'left', valign: 'top' }],
    ];
    for (const [anchor, want] of cases) {
      expect(textAlignments(undefined, undefined, undefined, anchor)).toEqual(want);
    }
  });

  it('anchor 优先于 horizontalalign/verticalalign/alignment', () => {
    expect(textAlignments('center', 'center', 'center', 'topright')).toEqual({ halign: 'right', valign: 'top' });
    expect(textAlignments('left', 'bottom', undefined, 'topleft')).toEqual({ halign: 'left', valign: 'top' });
  });

  it('anchor "none"/未知值/缺省 → 回退既有 alignment 族推导', () => {
    expect(textAlignments('left', 'bottom', 'topright', 'none')).toEqual({ halign: 'left', valign: 'bottom' });
    expect(textAlignments(undefined, undefined, 'bottomright', 'bogus')).toEqual({ halign: 'right', valign: 'bottom' });
    expect(textAlignments(undefined, undefined, undefined)).toEqual({ halign: 'center', valign: 'center' });
  });

  it('textLayerOffset 按 anchor 决定 origin 落在文本框哪条边（topright → 右上缘）', () => {
    const layout = { width: 120, height: 60, textWidth: 100, textHeight: 50 };
    expect(textLayerOffset(layout, undefined, undefined, undefined, [1, 1, 1], 'topright')).toEqual([-50, -25]);
    expect(textLayerOffset(layout, undefined, undefined, undefined, [2, 2, 1], 'bottomleft')).toEqual([100, 50]);
    expect(textLayerOffset(layout, undefined, undefined, undefined, [1, 1, 1], 'none')).toEqual([0, 0]);
  });

  // 评审 Important 1：用真实素材的 origin/scale/anchor 证明 anchor 只决定 quad 原点（方向正确）。
  // 2937346640 obj182：horizontalalign=left + anchor=right；布局宽取示例，方向/倍率与实测宽无关。
  it('真实对象 2937346640#182：anchor=right 把原点钉在文本框右缘（quad 中心左移 textWidth×scale）', () => {
    const layout = { width: 1413, height: 196, textWidth: 1413, textHeight: 196 };
    const scale: [number, number, number] = [0.49463, 0.49463, 1];   // 素材 obj182 的 scale
    const [byAlign] = textLayerOffset(layout, 'left', 'center', undefined, scale);
    const [byAnchor] = textLayerOffset(layout, 'left', 'center', undefined, scale, 'right');
    expect(byAlign).toBeCloseTo(1413 / 2 * 0.49463, 3);      // 无 anchor：origin = 左缘，中心在右
    expect(byAnchor).toBeCloseTo(-1413 / 2 * 0.49463, 3);    // anchor=right：origin = 右缘，中心在左
    // origin.x 到 quad 右缘的距离 = 0（anchor 方向正确）；两种锚点下中心位移 = textWidth×scale
    expect(1859.88074 + byAnchor + 1413 / 2 * 0.49463).toBeCloseTo(1859.88074, 3);
    expect(byAnchor - byAlign).toBeCloseTo(-1413 * 0.49463, 3);
  });

  // 评审 Important 1：1922570576 obj778 的 anchor=center 覆盖 verticalalign=top（e2e 精确 rect 的依据）。
  it('真实对象 1922570576#778：anchor=center 使 verticalalign=top 失效，quad 相对上移半个文本框高', () => {
    // 素材 obj778：padding 32、纹理 884×228 ⇒ 文本框 820×164、scale 1
    const layout = { width: 884, height: 228, textWidth: 820, textHeight: 164 };
    const [, byAlign] = textLayerOffset(layout, 'center', 'top', undefined, [1, 1, 1]);
    const [ax, byAnchor] = textLayerOffset(layout, 'center', 'top', undefined, [1, 1, 1], 'center');
    expect(byAlign).toBe(-164 / 2);            // verticalalign=top：origin 是上缘（中心在下）
    expect([ax, byAnchor]).toEqual([0, 0]);    // anchor=center：origin 即中心
    expect(byAnchor - byAlign).toBe(164 / 2);  // 上移半高（屏幕 y 减少 ≈31px，见 e2e 基线）
  });
});

// v0.8.2 F12：brightness = 颜色乘系数；>1 用「同一字形再叠加一遍」近似增亮（canvas 侧，spec §3）。
describe('drawTextToCanvas brightness（F12）', () => {
  let ctx: ReturnType<typeof makeMock2d>;
  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  /** 记录每次 fillText 当刻的合成状态（brightness>1 时会有多次绘制）。 */
  function recordPasses() {
    const passes: Array<{ text: string; op: string; alpha: number }> = [];
    ctx.fillText.mockImplementation((text: string) => {
      passes.push({ text: String(text), op: String(ctx.globalCompositeOperation), alpha: ctx.globalAlpha });
    });
    return passes;
  }

  it('brightness 缺省/1 → 单次 source-over 绘制（旧行为零回归）', () => {
    const passes = recordPasses();
    drawTextToCanvas(document.createElement('canvas'), 'A', { pointsize: 10, width: 40, height: 40 });
    drawTextToCanvas(document.createElement('canvas'), 'A', { pointsize: 10, width: 40, height: 40, brightness: 1 });
    expect(passes).toEqual([
      { text: 'A', op: 'source-over', alpha: 1 },
      { text: 'A', op: 'source-over', alpha: 1 },
    ]);
  });

  it('brightness < 1 → 颜色按系数压暗（单次绘制）', () => {
    drawTextToCanvas(document.createElement('canvas'), 'A', {
      pointsize: 10, width: 40, height: 40, color: [200, 100, 50], brightness: 0.5,
    });
    expect(ctx.fillStyle).toBe('rgb(100, 50, 25)');
    expect(ctx.fillText).toHaveBeenCalledTimes(1);
  });

  it('brightness > 1 → 追加 lighter 叠加绘制（1.4 → 基色 + alpha 0.4 一遍）', () => {
    const passes = recordPasses();
    drawTextToCanvas(document.createElement('canvas'), 'AB', {
      pointsize: 10, width: 60, height: 40, color: [200, 100, 50], brightness: 1.4,
    });
    expect(passes.map((p) => ({ text: p.text, op: p.op }))).toEqual([
      { text: 'AB', op: 'source-over' },
      { text: 'AB', op: 'lighter' },
    ]);
    expect(passes[0].alpha).toBe(1);
    expect(passes[1].alpha).toBeCloseTo(0.4, 6);
    // 叠加仍用完整颜色（不是压暗后的）；绘制结束复位合成状态，避免污染下一次重绘
    expect(ctx.fillStyle).toBe('rgb(200, 100, 50)');
    expect(ctx.globalCompositeOperation).toBe('source-over');
    expect(ctx.globalAlpha).toBe(1);
  });

  it('brightness > 2 → 拆成多遍叠加，总系数 = brightness（2.39 → 1 + 1 + 0.39）', () => {
    const passes = recordPasses();
    drawTextToCanvas(document.createElement('canvas'), 'A', { pointsize: 10, width: 40, height: 40, brightness: 2.39 });
    const add = passes.filter((p) => p.op === 'lighter');
    expect(add).toHaveLength(2);
    expect(add[0].alpha).toBe(1);
    expect(add[1].alpha).toBeCloseTo(0.39, 6);
    expect(add.reduce((n, p) => n + p.alpha, 0)).toBeCloseTo(1.39, 6);
  });

  it('brightness 非法（NaN/负数）→ 按 1 处理，不抛错', () => {
    expect(() => drawTextToCanvas(document.createElement('canvas'), 'A', {
      pointsize: 10, width: 40, height: 40, brightness: Number.NaN,
    })).not.toThrow();
    drawTextToCanvas(document.createElement('canvas'), 'A', { pointsize: 10, width: 40, height: 40, brightness: -2 });
    expect(ctx.fillText).toHaveBeenCalledTimes(2);
  });
});
