// 两张截图逐像素对拍（零回归证据）：默认比较 e2e/.out 下同名的 A/B 两张图。
//
// 用法：node e2e/verify/compare-shots.mjs --a=<png> --b=<png> [--tag-a=baseline] [--tag-b=after]
//   --a/--b 省略时按 `--dir + --tag-a/--tag-b + --dprs` 拼出文件名（verify-hidpi-object-rt 的产物命名）。
// 判据：最大差 ≤ 1 且 差≥2 的像素占比为 0 → 视为逐像素一致（时间驱动壁纸请用冻结相位的 harness）。
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { argOf, OUT_DIR } from '../config.mjs';
import { decodePng } from '../lib/png-stats.mjs';

const dir = argOf('dir', join(OUT_DIR, 'hidpi-object-rt'));
const tagA = argOf('tag-a', 'baseline');
const tagB = argOf('tag-b', 'after');
const dprs = String(argOf('dprs', '1,2')).split(',').map((s) => Number(s.trim()));

let failed = false;
for (const dpr of dprs) {
  const pa = argOf('a', join(dir, `${tagA}-dpr${dpr}.png`));
  const pb = argOf('b', join(dir, `${tagB}-dpr${dpr}.png`));
  if (!existsSync(pa) || !existsSync(pb)) {
    console.log(`dpr=${dpr} 缺少截图：${!existsSync(pa) ? pa : pb}`);
    failed = true;
    continue;
  }
  const A = decodePng(readFileSync(pa));
  const B = decodePng(readFileSync(pb));
  if (A.width !== B.width || A.height !== B.height) {
    console.log(`dpr=${dpr} [FAIL] 尺寸不同：${A.width}x${A.height} vs ${B.width}x${B.height}`);
    failed = true;
    continue;
  }
  const n = A.width * A.height;
  let maxAbs = 0, sumAbs = 0, changedPx = 0;
  for (let i = 0; i < n; i++) {
    let pxDiff = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A.data[i * A.channels + c] - B.data[i * B.channels + c]);
      sumAbs += d;
      if (d > pxDiff) pxDiff = d;
      if (d > maxAbs) maxAbs = d;
    }
    if (pxDiff >= 2) changedPx++;
  }
  const mad = sumAbs / (n * 3);
  const ok = maxAbs <= 1 && changedPx === 0;
  if (!ok) failed = true;
  console.log(
    `dpr=${dpr}  ${A.width}x${A.height}  ${ok ? '[PASS]' : '[FAIL]'}  平均绝对差=${mad.toFixed(4)}/255  ` +
      `最大差=${maxAbs}  差≥2 像素=${changedPx}/${n}（${((changedPx / n) * 100).toFixed(4)}%）`,
  );
}
if (failed) process.exitCode = 1;
