// @vitest-environment jsdom
// T3.1 text 对象静态文本：createTextTexture 把文本绘制到离屏 canvas → CanvasTexture。
// jsdom 未实现 canvas 2D（仓库未装 node-canvas，getContext('2d') 默认返回 null），
// 与 tex-loader.test.ts 的 mock 全局思路一致：mock HTMLCanvasElement.prototype.getContext
// 返回记录型 2D 上下文，断言绘制参数（字号/颜色/居中）与返回纹理的宽高。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { createTextTexture, textCanvasSize } from '../src/client/text-object.js';

// 记录型 2D 上下文：捕获 createTextTexture 设置的绘制状态与 fillText 调用
function makeMock2d() {
  return {
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    fillText: vi.fn(),
  };
}

describe('createTextTexture', () => {
  let ctx: ReturnType<typeof makeMock2d>;

  beforeEach(() => {
    ctx = makeMock2d();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('绘制参数：pointsize 字号、白色默认、水平垂直居中、文本画在画布中心', () => {
    createTextTexture('12:00', { pointsize: 80, width: 400, height: 100 });
    expect(ctx.font).toBe('80px sans-serif');
    expect(ctx.fillStyle).toBe('#ffffff');
    expect(ctx.textAlign).toBe('center');
    expect(ctx.textBaseline).toBe('middle');
    expect(ctx.fillText).toHaveBeenCalledWith('12:00', 200, 50);
  });

  it('font 为文件路径（fonts/xxx.otf）→ 回退 sans-serif；字体家族名直用', () => {
    createTextTexture('x', { font: 'fonts/Atami-Regular.otf', pointsize: 20, width: 100, height: 50 });
    expect(ctx.font).toBe('20px sans-serif');
    createTextTexture('y', { font: 'Arial', pointsize: 24, width: 100, height: 50 });
    expect(ctx.font).toBe('24px Arial');
  });

  it('color [r,g,b] → rgb() fillStyle', () => {
    createTextTexture('x', { color: [255, 0, 128], width: 100, height: 50 });
    expect(ctx.fillStyle).toBe('rgb(255, 0, 128)');
  });

  it('缺 pointsize → 按画布高度 80% 估算字号', () => {
    createTextTexture('x', { width: 100, height: 50 });
    expect(ctx.font).toBe('40px sans-serif');
  });

  it('canvas 2D 不可用（getContext 返回 null）→ 仍返回空纹理不抛错', () => {
    // 显式 mock 返回 null（等价 jsdom 无 node-canvas 的默认行为，且不触发 jsdom 的
    // "Not implemented" virtual-console 报错噪声）
    vi.mocked(HTMLCanvasElement.prototype.getContext).mockReturnValue(null);
    const tex = createTextTexture('x', { width: 10, height: 10 });
    expect(tex).toBeInstanceOf(THREE.CanvasTexture);
  });
});

describe('textCanvasSize（缺省画布尺寸兜底）', () => {
  it('有 size → 取整后原样返回（下限 1，不产生退化画布）', () => {
    expect(textCanvasSize('abc', 80, [400, 100])).toEqual({ w: 400, h: 100 });
    expect(textCanvasSize('abc', 80, [0, -5])).toEqual({ w: 1, h: 1 });
  });
  it('无 size → 按字号与文本长度估算（宽 = 字号×长度×0.62，高 = 字号×1.4）', () => {
    const s = textCanvasSize('12:00', 80, undefined);
    expect(s.w).toBe(Math.max(32, Math.ceil(80 * 5 * 0.62)));
    expect(s.h).toBe(Math.max(16, Math.ceil(80 * 1.4)));
  });
  it('无 size 且无 pointsize → 默认字号 32，空文本也给出非零尺寸', () => {
    const s = textCanvasSize('', undefined, undefined);
    expect(s.w).toBeGreaterThan(0);
    expect(s.h).toBeGreaterThan(0);
  });
});
