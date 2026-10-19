import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 数据目录环境变量：设置后覆盖默认位置（迁移 / 测试用）。 */
export const DATA_DIR_ENV = 'DSH_USE_WALLPAPER_DATA_DIR';

export function resolveDataDir(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const env = opts.env ?? process.env;
  const explicit = env[DATA_DIR_ENV]?.trim();
  return explicit ? explicit : join(opts.home ?? homedir(), '.dsh-use-wallpaper');
}

/** 创建并返回数据目录（幂等）。 */
export function ensureDataDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 抓帧 PNG 目录。 */
export function framesDirOf(dataDir: string): string {
  return join(dataDir, 'frames');
}
