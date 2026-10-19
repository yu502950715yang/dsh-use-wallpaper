/** 注入式编码器：收到**已翻成图像行序**的 RGBA，返回 PNG 字节。 */
export type RgbaEncoder = (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array>;
export interface ReadPixelsGl {
    RGBA: number;
    UNSIGNED_BYTE: number;
    readPixels(x: number, y: number, w: number, h: number, format: number, type: number, pixels: Uint8Array): void;
}
/** GL 的像素原点在**底行**，PNG/ImageData 在顶行 ⇒ 按行倒序拷贝（行内字节序不变）。 */
export declare function flipRgbaRows(rgba: Uint8Array, width: number, height: number): Uint8Array;
/** RGBA → PNG 字节；编码环境不支持 / 编码抛错 / 尺寸非法 → null。 */
export declare function encodeRgbaToPng(rgba: Uint8Array, width: number, height: number, encode?: RgbaEncoder): Promise<Uint8Array | null>;
/** 读默认 framebuffer 的 RGBA → 翻成图像行序 → 编码 PNG；读/编码失败 → null。 */
export declare function readPixelsToPng(gl: ReadPixelsGl, width: number, height: number, encode?: RgbaEncoder): Promise<Uint8Array | null>;
