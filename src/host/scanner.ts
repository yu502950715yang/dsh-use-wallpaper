import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WallpaperInfo, WallpaperKind } from '../shared/types.js';

export function kindFromProjectJson(pj: Record<string, unknown>): WallpaperKind {
  // WE 写的 type 大小写不定（实测 "Web"/"Scene"）；不归一化会掉进 unknown，
  // 非 scene 的（如 web）就无法走各自分支、只剩 preview 图兜底。
  const t = String(pj.type ?? '').trim().toLowerCase();
  if (t === 'scene' || t === 'video' || t === 'web' || t === 'image') return t;
  // WE 预设壁纸：只有 dependency + preset + preview，没有 type/file —— 按依赖壁纸渲染（v0.9）。
  if (typeof pj.dependency === 'string' && pj.dependency.trim()) return 'preset';
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
    const type = kindFromProjectJson(pj);
    const presetOf = type === 'preset' ? String(pj.dependency).trim() : undefined;
    // preset 的 scene 资源在依赖目录（自身目录没有 scene.pkg）；依赖 id 校验为纯数字防穿越。
    const hasScene = existsSync(join(dir, id, 'scene.pkg'))
      || (!!presetOf && /^[0-9]+$/.test(presetOf) && existsSync(join(dir, presetOf, 'scene.pkg')));
    const preview = existsSync(join(dir, id, 'preview.gif')) ? 'gif' : existsSync(join(dir, id, 'preview.jpg')) ? 'jpg' : null;
    out.push({
      id,
      title: String(pj.title ?? id),
      type,
      presetOf,
      file: typeof pj.file === 'string' ? pj.file : undefined,
      hasPreviewGif: preview === 'gif',
      hasScene,
      previewUrl: preview ? `/wallpapers/media/${id}/preview` : '',
    });
  }
  return out;
}
