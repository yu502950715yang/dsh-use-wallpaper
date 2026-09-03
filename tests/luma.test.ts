import { describe, expect, it } from 'vitest';
import { averageLuma, lumaToTextColor, LUMA_THRESHOLD, TEXT_DARK, TEXT_LIGHT } from '../src/client/luma.js';

// 文字颜色跟随壁纸亮度（2026-09-03）：纯计算函数在 node 环境可测。

function rgba(pixels: number[]): Uint8ClampedArray {
  return new Uint8ClampedArray(pixels);
}

describe('averageLuma（平均亮度，Rec.601 加权）', () => {
  it('全黑像素 → 0', () => {
    // 2 个纯黑像素
    expect(averageLuma(rgba([0, 0, 0, 255, 0, 0, 0, 255]))).toBe(0);
  });
  it('全白像素 → 255', () => {
    expect(averageLuma(rgba([255, 255, 255, 255, 255, 255, 255, 255]))).toBe(255);
  });
  it('中灰像素 → 128', () => {
    // 0.299*128 + 0.587*128 + 0.114*128 = 128
    expect(averageLuma(rgba([128, 128, 128, 255]))).toBeCloseTo(128, 0);
  });
  it('空数组 → 0（防御，不抛错）', () => {
    expect(averageLuma(new Uint8ClampedArray(0))).toBe(0);
  });
});

describe('lumaToTextColor（亮度 → 文字色）', () => {
  it('阈值 = 128', () => {
    expect(LUMA_THRESHOLD).toBe(128);
  });
  it('暗壁纸（<128）→ 白字 TEXT_DARK', () => {
    expect(lumaToTextColor(96)).toBe(TEXT_DARK);
    expect(lumaToTextColor(0)).toBe(TEXT_DARK);
  });
  it('亮壁纸（>=128）→ 黑字 TEXT_LIGHT', () => {
    expect(lumaToTextColor(128)).toBe(TEXT_LIGHT);
    expect(lumaToTextColor(255)).toBe(TEXT_LIGHT);
  });
  it('文字色常量定义正确（暗→白 f9fafb，亮→黑 0f1115）', () => {
    expect(TEXT_DARK).toBe('#f9fafb');
    expect(TEXT_LIGHT).toBe('#0f1115');
  });
});
