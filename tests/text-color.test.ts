import { describe, expect, it } from 'vitest';
import {
  TEXT_OUTLINE_MAX,
  hexLuma,
  manualTextColor,
  normalizeHexColor,
  normalizeMode,
  normalizeOutlineLevel,
  outlineLabel,
  outlineShadow,
} from '../src/client/text-color.js';

// 「文字看不清」的手动解法：文字色模式（自动/白/黑/自定义）+ 可选描边。
// 关键不变量：未知/缺省模式必须回 auto（＝保持既有「跟随壁纸亮度」行为），
// 非法颜色不得原样写进 CSS 变量，0 档描边必须等于「没有描边」。

describe('normalizeMode', () => {
  it('四个合法模式原样返回', () => {
    expect(normalizeMode('auto')).toBe('auto');
    expect(normalizeMode('white')).toBe('white');
    expect(normalizeMode('black')).toBe('black');
    expect(normalizeMode('custom')).toBe('custom');
  });
  it('未知/缺省/非字符串 → auto（保持既有行为，不误改用户观感）', () => {
    expect(normalizeMode(undefined)).toBe('auto');
    expect(normalizeMode(null)).toBe('auto');
    expect(normalizeMode('')).toBe('auto');
    expect(normalizeMode('WHITE')).toBe('auto');
    expect(normalizeMode(42)).toBe('auto');
  });
});

describe('normalizeHexColor', () => {
  it('接受 #rgb / #rrggbb，大小写归一为小写', () => {
    expect(normalizeHexColor('#FFF')).toBe('#fff');
    expect(normalizeHexColor('#00FF80')).toBe('#00ff80');
    expect(normalizeHexColor('  #abcdef ')).toBe('#abcdef');
  });
  it('非法值回退（不得原样写进 CSS 变量）', () => {
    expect(normalizeHexColor('red')).toBe('#ffffff');
    expect(normalizeHexColor('#12345')).toBe('#ffffff');
    expect(normalizeHexColor('white;background:url(x)')).toBe('#ffffff');
    expect(normalizeHexColor(123)).toBe('#ffffff');
    expect(normalizeHexColor('#fff', '#000000')).toBe('#fff');
    expect(normalizeHexColor('bad', '#000000')).toBe('#000000');
  });
});

describe('manualTextColor', () => {
  it('auto → null（交给 preview 亮度测量，不固定颜色）', () => {
    expect(manualTextColor('auto', '#123456')).toBeNull();
    expect(manualTextColor(undefined, '#123456')).toBeNull();
  });
  it('white / black 返回纯色', () => {
    expect(manualTextColor('white', '')).toBe('#ffffff');
    expect(manualTextColor('black', '')).toBe('#000000');
  });
  it('custom 用用户值（非法则回退白色，不留空）', () => {
    expect(manualTextColor('custom', '#ff8800')).toBe('#ff8800');
    expect(manualTextColor('custom', 'nonsense')).toBe('#ffffff');
    expect(manualTextColor('custom', undefined)).toBe('#ffffff');
  });
});

describe('hexLuma', () => {
  it('与 Rec.601 口径一致', () => {
    expect(hexLuma('#000000')).toBe(0);
    expect(hexLuma('#ffffff')).toBeCloseTo(255, 5);
    expect(hexLuma('#ff0000')).toBeCloseTo(76.245, 3);
    expect(hexLuma('#00ff00')).toBeCloseTo(149.685, 3);
  });
  it('#rgb 缩写按位展开', () => {
    expect(hexLuma('#fff')).toBeCloseTo(hexLuma('#ffffff'), 5);
    expect(hexLuma('#000')).toBe(0);
  });
});

describe('normalizeOutlineLevel', () => {
  it('四舍五入并钳到 [0, 3]', () => {
    expect(normalizeOutlineLevel(0)).toBe(0);
    expect(normalizeOutlineLevel(2)).toBe(2);
    expect(normalizeOutlineLevel(1.4)).toBe(1);
    expect(normalizeOutlineLevel(1.5)).toBe(2);
    expect(normalizeOutlineLevel(-1)).toBe(0);
    expect(normalizeOutlineLevel(99)).toBe(TEXT_OUTLINE_MAX);
  });
  it('非数值 → 0（关）', () => {
    expect(normalizeOutlineLevel(undefined)).toBe(0);
    expect(normalizeOutlineLevel(NaN)).toBe(0);
    expect(normalizeOutlineLevel('x')).toBe(0);
    expect(normalizeOutlineLevel('2')).toBe(2);
  });
});

describe('outlineShadow', () => {
  it('0 档 = 没有描边（null，调用方移除变量 → 既有观感不变）', () => {
    expect(outlineShadow('#ffffff', 0)).toBeNull();
    expect(outlineShadow('#ffffff', undefined)).toBeNull();
  });
  it('亮字配深色阴影、暗字配浅色阴影（对立色才托得住对比）', () => {
    expect(outlineShadow('#ffffff', 1)).toContain('rgba(0,0,0,');
    expect(outlineShadow('#000000', 1)).toContain('rgba(255,255,255,');
    // 中间调跟着亮度翻转阈值走：黄色亮 → 深边；深蓝暗 → 亮边
    expect(outlineShadow('#ffff00', 1)).toContain('rgba(0,0,0,');
    expect(outlineShadow('#000080', 1)).toContain('rgba(255,255,255,');
  });
  it('档位越高层数越多（阴影叠加得更厚）', () => {
    // 每层恰好一段带 px 偏移（rgba 自身含逗号，不能按逗号数层）
    const layers = (lv: number) => (outlineShadow('#ffffff', lv) ?? '').split(',').filter((p) => /px/.test(p)).length;
    expect(layers(1)).toBe(1);
    expect(layers(2)).toBe(2);
    expect(layers(3)).toBe(3);
  });
  it('非法颜色不会把任意串带进 text-shadow 值', () => {
    const s = outlineShadow('red;background:url(x)', 1) ?? '';
    expect(s).toContain('rgba(255,255,255,');
    expect(s).not.toContain('url(');
  });
});

describe('outlineLabel', () => {
  it('档位 → 面板文案（0 关 / 1-3 递增；越界与非法值有定义行为）', () => {
    expect(outlineLabel(0)).toBe('关');
    expect(outlineLabel(1)).toBe('轻');
    expect(outlineLabel(2)).toBe('中');
    expect(outlineLabel(3)).toBe('强');
    expect(outlineLabel(99)).toBe('强');
    expect(outlineLabel(-5)).toBe('关');
    expect(outlineLabel(undefined)).toBe('关');
  });
});
