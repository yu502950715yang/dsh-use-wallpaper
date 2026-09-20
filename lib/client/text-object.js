// src/client/text-object.ts —— WE text 对象文本渲染（T3.1 静态 + T3.3 时钟驱动 + 脚本驱动）
// 把文本绘制到离屏 canvas（2D），包装为 THREE.CanvasTexture 供 quad 贴图。
// 时钟/脚本走字**就地重绘同一 canvas**（只置 needsUpdate），不重建纹理。
import * as THREE from 'three';
import { formatClockText } from './script-patterns.js';
// WE 字体名可能是字体文件路径（fonts/xxx.otf）或字体家族名；浏览器无法用文件路径
// 直接绘制，含路径分隔符/扩展名的一律回退默认无衬线字体（设计 A5：字体加载失败回退
// 系统 sans-serif；字体加载管线不在本任务范围）。
// WE 的系统字体名（`systemfont_*`，如 CodeTime 用 systemfont_consolas）→ CSS 家族列表。
// 未知的 systemfont_* 回退 sans-serif；家族名本身直用（多词加引号）。
const WE_SYSTEM_FONTS = {
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
function resolveFontFamily(font) {
    if (typeof font !== 'string' || !font.trim())
        return 'sans-serif';
    const name = font.trim();
    const sys = WE_SYSTEM_FONTS[name.toLowerCase()];
    if (sys)
        return sys;
    if (name.toLowerCase().startsWith('systemfont_'))
        return 'sans-serif';
    if (/[/\\]/.test(name) || /\.[a-zA-Z0-9]{2,4}$/.test(name))
        return 'sans-serif';
    return name.includes(' ') ? `"${name}"` : name;
}
// 缺省画布尺寸（T3.1）：text 对象通常带 size 字段（WE 像素）；缺失时按字号与文本
// 长度估算，避免 0 尺寸退化画布或长文本被画布边界裁切。返回取整后非零尺寸。
export function textCanvasSize(text, pointsize, size) {
    if (size)
        return { w: Math.max(1, Math.round(size[0])), h: Math.max(1, Math.round(size[1])) };
    const ps = Math.max(1, pointsize ?? 32);
    return {
        w: Math.max(32, Math.ceil(ps * Math.max(text.length, 2) * 0.62)),
        h: Math.max(16, Math.ceil(ps * 1.4)),
    };
}
// 把文本绘制到指定 canvas（就地重绘：时钟走字复用同一 canvas/纹理，只需 needsUpdate）。
// 文本水平/垂直居中（alignment 字段暂不参与布局）。2D 上下文不可用时静默留白，不抛错。
export function drawTextToCanvas(canvas, text, opts) {
    const width = Math.max(1, Math.round(opts.width));
    const height = Math.max(1, Math.round(opts.height));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return;
    const size = Math.max(1, opts.pointsize ?? Math.round(height * 0.8));
    // M29：多词字体家族名（如 "Times New Roman"）在 CSS font 简写中必须加引号，
    // 否则整段 font 被浏览器视为非法而静默回退默认字体（单词家族不受影响）。
    // family 已是完整 CSS 家族列表（可能是 `Consolas, "Courier New", monospace`）→ 不再二次加引号。
    const family = resolveFontFamily(opts.font);
    ctx.font = `${size}px ${family}`;
    ctx.fillStyle = opts.color ? `rgb(${opts.color[0]}, ${opts.color[1]}, ${opts.color[2]})` : '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // canvas 的 fillText 不处理换行 → 按 \n 分行绘制、整块垂直居中（WE 文本常带多行）；
    // \t 也不产生缩进 → 展开为空格（CodeTime 的标签列靠它做缩进）。
    const lines = String(text).split('\n').map((line) => line.replace(/\t/g, ' '));
    const lineHeight = size * 1.2;
    const firstY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, i) => ctx.fillText(line, width / 2, firstY + i * lineHeight));
}
// 把文本绘制到新建的离屏 canvas，返回 CanvasTexture（needsUpdate 已置位）。
export function createTextTexture(text, opts) {
    const canvas = document.createElement('canvas');
    drawTextToCanvas(canvas, text, opts);
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
}
// 脚本驱动：每帧问脚本要新文本，变化才重绘（与 clock 驱动同形态，忽略 now）。
// initialText = 装配期已画进 canvas 的脚本首帧值（避免首帧以相同文本重绘一次）。
export function createScriptDriver(canvas, opts, binding, initialText = '') {
    let last = initialText;
    return {
        update(_now) {
            const text = binding.update();
            if (text === null || text === '' || text === last)
                return false;
            drawTextToCanvas(canvas, text, opts);
            last = text;
            return true;
        },
    };
}
// 时钟驱动：按 formatClockText 生成文本，**文本变化才重绘**（同分钟不重绘）。
export function createClockDriver(canvas, opts, props, initialText) {
    let last = initialText;
    return {
        update(now) {
            const text = formatClockText(now, props);
            if (text === last)
                return false;
            drawTextToCanvas(canvas, text, opts);
            last = text;
            return true;
        },
    };
}
