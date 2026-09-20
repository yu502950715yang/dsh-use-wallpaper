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

  it('font 为文件路径（fonts/xxx.otf）→ 回退 sans-serif；字体家族名直用；WE 系统字体名映射', () => {
    createTextTexture('x', { font: 'fonts/Atami-Regular.otf', pointsize: 20, width: 100, height: 50 });
    expect(ctx.font).toBe('80px sans-serif');
    createTextTexture('y', { font: 'Arial', pointsize: 24, width: 100, height: 50 });
    expect(ctx.font).toBe('96px Arial');
    createTextTexture('x', { font: 'systemfont_consolas', pointsize: 32, width: 100, height: 50 });
    expect(ctx.font).toBe('128px Consolas, "Courier New", monospace');
    createTextTexture('y', { font: 'systemfont_arial', pointsize: 32, width: 100, height: 50 });
    expect(ctx.font).toBe('128px Arial, Helvetica, sans-serif');
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
