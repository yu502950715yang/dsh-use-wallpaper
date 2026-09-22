// HiDPI 对象级 RT 修复验证所需的**纯像素度量**（research 临时脚本，不入库）。
//
// 设计目标：给出**与动画相位无关**、可复现、可解释的度量，不做「看起来差不多」的主观判断。
//   · downsampleBox     —— dpr=2 截图 → dpr=1 网格（严格 2×2 盒式平均），使两图可逐像素比较；
//   · meanAbsDiff       —— 逐像素平均绝对差 / 最大差 / 差 ≥2 的像素占比 / 差异 bbox；
//   · clampBands        —— **边缘 clamp 拉伸的客观指纹**：被 clamp 的区段里，每一列（或每一行）
//                          都是相邻列的**逐像素完全复制**（采样器钉在同一个 texel）。于是
//                          「左侧/右侧连续完全重复列的长度」直接量化了「边缘被拉伸」的范围。
//                          （这是视觉症状「条纹 / 边缘拉伸」的无阈值版本：完全相等，不含容差）；
//   · detailedSpan      —— 非重复列的跨度（内容真正占据的范围），即「内容外接包围盒」的横/纵向口径；
//   · bestZoom          —— 以中心为不动点搜索最优缩放 k，使两图最相似：k≈1 = 尺度一致，
//                          k≫1 = 一图内容被放大（尺度不一致）。用于量化「尺度一致性」。
import { decodePng } from './png-stats.mjs';

export { decodePng };

/** 严格整数倍盒式下采样：out[y][x] = mean of the fx×fy block。fx/fy 必须整除。 */
export function downsampleBox(img, fx, fy) {
  if (img.width % fx !== 0 || img.height % fy !== 0) throw new Error(`尺寸不能整除：${img.width}x${img.height} / ${fx}x${fy}`);
  const w = img.width / fx, h = img.height / fy, ch = img.channels;
  const out = Buffer.alloc(w * h * ch);
  const n = fx * fy;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let dy = 0; dy < fy; dy++) {
        const row = (y * fy + dy) * img.width;
        for (let dx = 0; dx < fx; dx++) {
          const o = (row + x * fx + dx) * ch;
          r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2];
          if (ch === 4) a += img.data[o + 3];
        }
      }
      const o = (y * w + x) * ch;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n);
      if (ch === 4) out[o + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, channels: ch, data: out };
}

/** 逐像素差分（RGB；忽略 alpha）。changed 口径 = 任一通道 |Δ| ≥ 2（与既有 e2e 一致）。 */
export function meanAbsDiff(A, B, mask = null) {
  if (A.width !== B.width || A.height !== B.height) throw new Error(`截图尺寸不一致：${A.width}x${A.height} vs ${B.width}x${B.height}`);
  const w = A.width, h = A.height, ca = A.channels, cb = B.channels;
  let n = 0, sum = 0, max = 0, changed = 0;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask && !mask[i]) continue;
      const oa = i * ca, ob = i * cb;
      const dr = Math.abs(A.data[oa] - B.data[ob]);
      const dg = Math.abs(A.data[oa + 1] - B.data[ob + 1]);
      const db = Math.abs(A.data[oa + 2] - B.data[ob + 2]);
      const d = Math.max(dr, dg, db);
      n++; sum += d; hist[d]++;
      if (d > max) max = d;
      if (d >= 2) { changed++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    }
  }
  const pct = (p) => { let acc = 0; for (let d = 0; d < 256; d++) { acc += hist[d]; if (acc >= n * p) return d; } return 255; };
  return {
    pixels: n, meanAbs: n ? sum / n : 0, max, changed, changedRatio: n ? changed / n : 0,
    p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), bbox: changed ? [minX, minY, maxX, maxY] : null,
  };
}

/**
 * 边缘 clamp 指纹：统计「与相邻列逐像素完全相等」的列。
 * 返回：
 *   dupCols     完全重复列总数（非背景噪声图里应当很少）；
 *   leftRun     从 x=0 起连续重复列数；rightRun 从 x=w-1 起连续重复列数；
 *   topRun/bottomRun 行方向同理；
 *   detailSpanX 存在横向细节（某行上 |I(x+1)-I(x-1)| ≠ 0）的列的最小/最大 x → 内容横向跨度。
 * 注：完全相等是**无容差**判据；被 clamp 的列采样同一 texel，必然完全相等。
 */
export function clampBands(img) {
  const { width: w, height: h, channels: ch, data } = img;
  const rowEq = (x) => { // 列 x 与列 x-1 是否完全相等
    for (let y = 0; y < h; y++) {
      const o0 = (y * w + x) * ch, o1 = (y * w + x - 1) * ch;
      if (data[o0] !== data[o1] || data[o0 + 1] !== data[o1 + 1] || data[o0 + 2] !== data[o1 + 2]) return false;
    }
    return true;
  };
  const colEq = (y) => {
    for (let x = 0; x < w; x++) {
      const o0 = (y * w + x) * ch, o1 = ((y - 1) * w + x) * ch;
      if (data[o0] !== data[o1] || data[o0 + 1] !== data[o1 + 1] || data[o0 + 2] !== data[o1 + 2]) return false;
    }
    return true;
  };
  const colDup = new Uint8Array(w);
  for (let x = 1; x < w; x++) if (rowEq(x)) colDup[x] = 1;
  const rowDup = new Uint8Array(h);
  for (let y = 1; y < h; y++) if (colEq(y)) rowDup[y] = 1;
  let leftRun = 0; for (let x = 1; x < w && colDup[x]; x++) leftRun++;
  let rightRun = 0; for (let x = w - 1; x >= 1 && colDup[x]; x--) rightRun++;
  let topRun = 0; for (let y = 1; y < h && rowDup[y]; y++) topRun++;
  let bottomRun = 0; for (let y = h - 1; y >= 1 && rowDup[y]; y--) bottomRun++;
  // 横向细节跨度：存在任一行的 |I(x+1)-I(x-1)| ≠ 0 的列
  let dminX = -1, dmaxX = -1;
  for (let x = 1; x < w - 1; x++) {
    let detail = false;
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * ch;
      if (data[o] !== data[o + ch] || data[o + 1] !== data[o + ch + 1] || data[o + 2] !== data[o + ch + 2]) { detail = true; break; }
    }
    if (detail) { if (dminX < 0) dminX = x; dmaxX = x; }
  }
  let dupCols = 0; for (let x = 1; x < w; x++) dupCols += colDup[x];
  let dupRows = 0; for (let y = 1; y < h; y++) dupRows += rowDup[y];
  return {
    w, h, dupCols, dupRows, leftRun, rightRun, topRun, bottomRun,
    detailSpanX: dminX < 0 ? null : [dminX, dmaxX],
  };
}

/**
 * 尺度一致性：以图像中心为不动点，搜索 k 使 ref(x) ≈ mov(cx + (x-cx)/k，即把 mov 视为 ref 的 k 倍放大）
 * 对齐后的平均绝对差最小。返回 { k, mad, madAtOne }。k≈1 → 两图尺度一致。
 * mov 必须与 ref 同尺寸（调用方先把 dpr=2 图下采样到 dpr=1 尺寸）。
 */
export function bestZoom(ref, mov, { min = 0.35, max = 2.8, steps = 60 } = {}) {
  if (ref.width !== mov.width || ref.height !== mov.height) throw new Error('bestZoom 需同尺寸输入');
  const w = ref.width, h = ref.height;
  const cx = (w - 1) / 2, cy = (h - 1) / 2;
  const madAt = (k) => {
    let sum = 0, n = 0;
    for (let y = 0; y < h; y += 2) {
      const sy = Math.round(cy + (y - cy) / k);
      if (sy < 0 || sy >= h) continue;
      for (let x = 0; x < w; x += 2) {
        const sx = Math.round(cx + (x - cx) / k);
        if (sx < 0 || sx >= w) continue;
        const oa = (y * w + x) * ref.channels, ob = (sy * w + sx) * mov.channels;
        for (let c = 0; c < 3; c++) sum += Math.abs(ref.data[oa + c] - mov.data[ob + c]);
        n += 3;
      }
    }
    return n ? sum / n : Infinity;
  };
  // 粗搜 + 局部细化（k=1 必须被显式求值：下采样后的最优对齐正是 1:1，网格不命中会让
  // 「最优 k」被最近的错位采样点带走，报出比 k=1 更差的 MAD —— 数值自相矛盾）
  let bk = 1, bm = madAt(1);
  for (let i = 0; i <= steps; i++) {
    const k = min * Math.pow(max / min, i / steps);
    const m = madAt(k);
    if (m < bm) { bm = m; bk = k; }
  }
  for (let pass = 0; pass < 3; pass++) {
    const span = bk * 0.12;
    for (let i = -10; i <= 10; i++) {
      const k = bk + (span * i) / 10;
      if (k <= 0.05) continue;
      const m = madAt(k);
      if (m < bm) { bm = m; bk = k; }
    }
  }
  return { k: bk, mad: bm, madAtOne: madAt(1) };
}
