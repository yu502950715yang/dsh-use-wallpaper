import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { scanWallpapers } from './scanner.js';
import type { WallpaperInfo } from '../shared/types.js';

/** 一次列表读取的结果：列表 + 弱 ETag。 */
export interface WallpaperListResult {
  list: WallpaperInfo[];
  etag: string;
}

export interface WallpaperListGetOptions {
  /** 强制重扫（「刷新」按钮用） */
  refresh?: boolean;
}

export interface WallpaperListCache {
  get(dir: string, opts?: WallpaperListGetOptions): Promise<WallpaperListResult>;
}

const CACHE_MAX = 4;
/** 目录不可读时的稳定 etag（无指纹可算）。 */
const EMPTY_ETAG = 'W/"0-0"';

/** 内容指纹 etag：refresh 改了内容而 mtime 不变时也必须变，否则旧 If-None-Match 会被误判 304。 */
function etagOf(list: WallpaperInfo[]): string {
  const hash = createHash('sha1').update(JSON.stringify(list)).digest('hex').slice(0, 12);
  return `W/"${list.length}-${hash}"`;
}

// 按根目录 mtimeMs 缓存扫描结果；Map 超上限淘汰最旧（同 getPkgReader 的手法）。
export function createWallpaperListCache(): WallpaperListCache {
  const cache = new Map<string, { mtimeMs: number; list: WallpaperInfo[]; etag: string }>();
  return {
    async get(dir, opts = {}) {
      let mtimeMs: number;
      try {
        mtimeMs = statSync(dir).mtimeMs;
      } catch {
        // 目录不存在/不可读：不写缓存，直接扫（scanWallpapers 自己返回空列表）
        return { list: await scanWallpapers(dir), etag: EMPTY_ETAG };
      }
      const hit = cache.get(dir);
      if (!opts.refresh && hit && hit.mtimeMs === mtimeMs) return { list: hit.list, etag: hit.etag };
      const list = await scanWallpapers(dir);
      const etag = etagOf(list);
      cache.set(dir, { mtimeMs, list, etag });
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return { list, etag };
    },
  };
}
