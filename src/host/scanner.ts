import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WallpaperInfo, WallpaperKind } from '../shared/types.js';

export function kindFromProjectJson(pj: Record<string, unknown>): WallpaperKind {
  const t = String(pj.type ?? '');
  if (t === 'scene' || t === 'video' || t === 'web' || t === 'image') return t;
  return 'unknown';
}

export async function scanWallpapers(dir: string): Promise<WallpaperInfo[]> {
  const out: WallpaperInfo[] = [];
  let ids: string[];
  try {
    ids = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return out;
  }
  for (const id of ids) {
    const pjPath = join(dir, id, 'project.json');
    if (!existsSync(pjPath)) continue;
    let pj: Record<string, unknown>;
    try {
      // 顶层非对象 JSON（null/数组/标量）视为损坏，跳过该目录（I5）
      const parsed: unknown = JSON.parse(readFileSync(pjPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) continue;
      pj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const hasScene = existsSync(join(dir, id, 'scene.pkg'));
    const preview = existsSync(join(dir, id, 'preview.gif')) ? 'gif' : existsSync(join(dir, id, 'preview.jpg')) ? 'jpg' : null;
    out.push({
      id,
      title: String(pj.title ?? id),
      type: kindFromProjectJson(pj),
      file: typeof pj.file === 'string' ? pj.file : undefined,
      hasPreviewGif: preview === 'gif',
      hasScene,
      previewUrl: preview ? `/wallpapers/media/${id}/preview` : '',
    });
  }
  return out;
}
