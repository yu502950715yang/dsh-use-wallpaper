/** 亮度中点：>= 此值视为亮壁纸（黑字），< 此值视为暗壁纸（白字）。 */
export declare const LUMA_THRESHOLD = 128;
export declare const TEXT_DARK = "#f9fafb";
export declare const TEXT_LIGHT = "#0f1115";
/** 从 RGBA 像素数组算平均亮度（0-255，Rec.601 感知加权）。纯函数，可测。 */
export declare function averageLuma(data: Uint8ClampedArray): number;
/** 平均亮度 → 文字颜色：暗(白字)/亮(黑字)。纯函数，可测。 */
export declare function lumaToTextColor(luma: number): string;
/** 加载一个 URL 的图片，缩样到 max 尺寸 canvas，返回平均亮度（0-255）。
 *  浏览器专用（依赖 Image/canvas/getImageData）。失败返回 null。 */
export declare function measureLuma(url: string, opts?: {
    max?: number;
}): Promise<number | null>;
