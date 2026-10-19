// scene 首帧导出的纯函数层：GL 像素行序翻转 + RGBA → PNG 编码（浏览器默认 OffscreenCanvas，测试可注入）。
// 任何失败都返回 null，不向调用方抛错（抓帧是可选优化，绝不能影响渲染/降级链）。
/** GL 的像素原点在**底行**，PNG/ImageData 在顶行 ⇒ 按行倒序拷贝（行内字节序不变）。 */
export function flipRgbaRows(rgba, width, height) {
    const rowBytes = Math.max(0, Math.floor(width)) * 4;
    const rows = Math.max(0, Math.floor(height));
    const out = new Uint8Array(rowBytes * rows);
    for (let y = 0; y < rows; y++) {
        out.set(rgba.subarray(y * rowBytes, (y + 1) * rowBytes), (rows - 1 - y) * rowBytes);
    }
    return out;
}
/** RGBA → PNG 字节；编码环境不支持 / 编码抛错 / 尺寸非法 → null。 */
export async function encodeRgbaToPng(rgba, width, height, encode) {
    try {
        if (encode)
            return await encode(rgba, width, height);
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
            return null;
        const w = Math.floor(width);
        const h = Math.floor(height);
        if (typeof OffscreenCanvas !== 'function')
            return null;
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx)
            return null;
        ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        return new Uint8Array(await blob.arrayBuffer());
    }
    catch {
        return null;
    }
}
/** 读默认 framebuffer 的 RGBA → 翻成图像行序 → 编码 PNG；读/编码失败 → null。 */
export async function readPixelsToPng(gl, width, height, encode) {
    try {
        if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
            return null;
        const w = Math.floor(width);
        const h = Math.floor(height);
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        return await encodeRgbaToPng(flipRgbaRows(buf, w, h), w, h, encode);
    }
    catch {
        return null;
    }
}
