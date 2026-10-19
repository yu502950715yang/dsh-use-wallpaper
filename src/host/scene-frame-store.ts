import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';

export const DEFAULT_MAX_FRAME_BYTES = 12 * 1024 * 1024;
export const DEFAULT_MAX_FRAME_FILES = 200;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type SceneFrameWriteResult =
  | { ok: true }
  | { ok: false; reason: 'bad-id' | 'too-large' | 'bad-png' | 'write-failed' };

export interface SceneFrameStoreOptions {
  maxBytes?: number;
  maxFiles?: number;
}

export interface SceneFrameStore {
  read(id: string): Buffer | null;
  write(id: string, png: Uint8Array): SceneFrameWriteResult;
  remove(id: string): { ok: true };
}

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id) && !id.includes('..');
}

/** 抓帧 PNG 存储：原子写 + 单文件/总数限额，id 白名单防穿越。 */
export function createSceneFrameStore(framesDir: string, opts: SceneFrameStoreOptions = {}): SceneFrameStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FRAME_FILES;
  let tmpSeq = 0;
  const fileOf = (id: string): string | null => (isSafeId(id) ? join(framesDir, id + '.png') : null);

  // 按 mtime 淘汰最旧帧；只认 .png，tmp 与用户文件不参与。
  const prune = () => {
    let names: string[];
    try {
      names = readdirSync(framesDir).filter((n) => n.endsWith('.png'));
    } catch {
      return;
    }
    if (names.length <= maxFiles) return;
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const n of names) {
      const path = join(framesDir, n);
      try {
        files.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // 读取失败的条目跳过，不影响其它帧
      }
    }
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (let i = 0; i < files.length - maxFiles; i++) {
      try {
        rmSync(files[i].path, { force: true });
      } catch {
        // 淘汰失败下次再试，不影响本次写入
      }
    }
  };

  return {
    read(id: string): Buffer | null {
      const file = fileOf(id);
      if (!file || !existsSync(file)) return null;
      try {
        return readFileSync(file);
      } catch {
        return null;
      }
    },
    write(id: string, png: Uint8Array): SceneFrameWriteResult {
      const file = fileOf(id);
      if (!file) return { ok: false, reason: 'bad-id' };
      if (png.length > maxBytes) return { ok: false, reason: 'too-large' };
      if (png.length < PNG_SIG.length || !PNG_SIG.equals(png.subarray(0, PNG_SIG.length))) {
        return { ok: false, reason: 'bad-png' };
      }
      // 原子写：临时文件 + rename，GET 不会读到半截 PNG。
      const tmp = `${file}.${process.pid}.${tmpSeq++}.tmp`;
      try {
        mkdirSync(framesDir, { recursive: true });
        writeFileSync(tmp, png);
        renameSync(tmp, file);
      } catch {
        try {
          rmSync(tmp, { force: true });
        } catch {
          // 清理失败忽略：tmp 不参与帧读取与淘汰
        }
        return { ok: false, reason: 'write-failed' };
      }
      prune();
      return { ok: true };
    },
    remove(id: string): { ok: true } {
      const file = fileOf(id);
      if (file) {
        try {
          rmSync(file, { force: true });
        } catch {
          // 删除失败按幂等处理（调用方只关心最终没有该帧）
        }
      }
      return { ok: true };
    },
  };
}
