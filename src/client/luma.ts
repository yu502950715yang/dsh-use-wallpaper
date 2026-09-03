// src/client/luma.ts —— 壁纸亮度检测工具（方案：文字颜色跟随壁纸亮度自动切换）
// 核心：读壁纸 preview 图的平均亮度，据此选文字颜色（暗壁纸白字 / 亮壁纸黑字）。
// 分离「纯计算」（可 node 单测）与「DOM 加载」（浏览器 Image/canvas）。

/** 亮度中点：>= 此值视为亮壁纸（黑字），< 此值视为暗壁纸（白字）。 */
export const LUMA_THRESHOLD = 128;

// 字体色常量：暗壁纸用浅色、亮壁纸用深色（读 CSS 变量由消费者使用，此处仅映射值）。
export const TEXT_DARK = '#f9fafb'; // 暗壁纸 → 白字
export const TEXT_LIGHT = '#0f1115'; // 亮壁纸 → 黑字

/** 从 RGBA 像素数组算平均亮度（0-255，Rec.601 感知加权）。纯函数，可测。 */
export function averageLuma(data: Uint8ClampedArray): number {
  if (data.length === 0) return 0;
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < n; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    sum += 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return sum / n;
}

/** 平均亮度 → 文字颜色：暗(白字)/亮(黑字)。纯函数，可测。 */
export function lumaToTextColor(luma: number): string {
  return luma < LUMA_THRESHOLD ? TEXT_DARK : TEXT_LIGHT;
}

/** 加载一个 URL 的图片，缩样到 max 尺寸 canvas，返回平均亮度（0-255）。
 *  浏览器专用（依赖 Image/canvas/getImageData）。失败返回 null。 */
export function measureLuma(url: string, opts?: { max?: number }): Promise<number | null> {
  const max = opts?.max ?? 32;
  return new Promise((resolve) => {
    if (typeof Image === 'undefined' || typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        if (!w || !h) { resolve(null); return; }
        // 保持比例缩样到 <=max 的小 canvas，显著减少读取量
        const scale = Math.min(1, max / Math.max(w, h));
        const sw = Math.max(1, Math.round(w * scale));
        const sh = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = sw;
        canvas.height = sh;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.drawImage(img, 0, 0, sw, sh);
        const data = ctx.getImageData(0, 0, sw, sh).data;
        resolve(averageLuma(data));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    // 防止同源/跨域受限时加载挂起
    img.src = url;
  });
}
