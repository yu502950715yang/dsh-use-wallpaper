// e2e 公共配置：统一解析机器相关路径与端口，消除脚本内硬编码。
// 所有脚本都应 import 本模块，不要各自再写一份默认值。
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** 仓库根（e2e/ 的上一级）。 */
export const REPO = join(here, '..');

/** e2e 产物目录（截图 / 临时浏览器 profile），已 gitignore。 */
export const OUT_DIR = process.env.E2E_OUT ?? join(here, '.out');

/** 解析 `--key=value` / `--key value` 形式的命令行参数，缺省回退 fallback。 */
export function argOf(name, fallback) {
  const argv = process.argv.slice(2);
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < argv.length && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
  return fallback;
}

/** 解析布尔开关 `--flag`。 */
export function flagOf(name) {
  return process.argv.slice(2).some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
}

// Edge 可执行文件：EDGE_PATH 优先，其次常见安装位置（64 位 / 32 位）。
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** 解析 Edge 路径；找不到时抛可读错误（不要静默失败）。 */
export function resolveEdgePath() {
  const fromEnv = process.env.EDGE_PATH;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`EDGE_PATH 指向的文件不存在：${fromEnv}`);
    return fromEnv;
  }
  const hit = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      '找不到 Microsoft Edge。请设置 EDGE_PATH 指向 msedge.exe，例如：\n' +
        '  $env:EDGE_PATH="C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"',
    );
  }
  return hit;
}

/** Steam workshop 壁纸目录（含本机素材的用例需要）。 */
export const WE_WORKSHOP = argOf('workshop', process.env.WE_WORKSHOP ?? 'D:/Steam/steamapps/workshop/content/431960');

/** Wallpaper Engine 安装目录（读内置粒子 / 效果纹理）。 */
export const WE_ASSETS = argOf('assets', process.env.WE_ASSETS ?? 'D:/Steam/steamapps/common/wallpaper_engine');

/** HTTP 服务端口：`--port` > `PORT` 环境变量 > fallback。 */
export function httpPort(fallback) {
  return Number(argOf('port', process.env.E2E_PORT ?? fallback));
}

/** CDP 调试端口：`--cdp-port` > `CDP_PORT` 环境变量 > fallback。 */
export function cdpPort(fallback) {
  return Number(argOf('cdp-port', process.env.E2E_CDP_PORT ?? fallback));
}

/** 各类等待上限（毫秒）；CI 慢机可用 E2E_TIMEOUT_MS 放宽。 */
export const TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS ?? 30000);

/** 断言文件存在，缺失时给可读的修复提示。 */
export function requireFile(path, hint) {
  if (!existsSync(path)) throw new Error(`缺少文件：${path}${hint ? `\n  ${hint}` : ''}`);
  return path;
}
