import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// scene 壁纸的包与入口解析。规则出处：we-layerd `WeProjectSource.cpp::ResolveProjectSource`——
// scene 的 pkg = `project.json.file` 的扩展名换成 `.pkg`（缺省 scene.pkg），入口 json = file 原值
// （缺省 scene.json）。WE 模板（如 GIF 导入）因此可能是 gifscene.pkg / gifscene.json。
export interface SceneSource {
  /** 提供场景包的目录（preset 时为依赖壁纸目录）。 */
  resDir: string;
  pkgPath: string;
  /** pkg 内场景入口 json 名（WE `project.json.file`；缺省 scene.json）。 */
  entry: string;
  hasPkg: boolean;
}

const DEFAULT_ENTRY = 'scene.json';
const DEFAULT_PKG = 'scene.pkg';

// file 是 pkg 内入口条目名：必须是包内相对路径（非绝对、无 ..），否则按缺省处理。
function isSafeEntry(file: string): boolean {
  if (file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:/.test(file)) return false;
  return !file.split(/[\\/]+/).includes('..');
}

export function resolveSceneSource(resDir: string, projectJson: unknown): SceneSource {
  let file = '';
  if (projectJson && typeof projectJson === 'object' && !Array.isArray(projectJson)) {
    const raw = (projectJson as { file?: unknown }).file;
    if (typeof raw === 'string') file = raw.trim();
  }
  if (file && isSafeEntry(file)) {
    const pkgPath = join(resDir, file.replace(/\.[^./\\]*$/, '') + '.pkg');
    if (existsSync(pkgPath)) return { resDir, pkgPath, entry: file, hasPkg: true };
    // file 指向的包不存在 → 回退标准名（保守，不把素材问题升级成失败）
  }
  const pkgPath = join(resDir, DEFAULT_PKG);
  return { resDir, pkgPath, entry: DEFAULT_ENTRY, hasPkg: existsSync(pkgPath) };
}

function readProjectJson(resDir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(resDir, 'project.json'), 'utf8'));
  } catch {
    return null;
  }
}

function isSafeDependencyId(dep: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(dep) && !dep.includes('..');
}

/** 完整解析：自身目录优先；preset（dependency）回退到依赖壁纸目录，入口按依赖自己的 project.json。 */
export function resolveWallpaperSceneSource(
  wallpaperDir: string,
  id: string,
  projectJson?: unknown,
): SceneSource {
  const pj = projectJson ?? readProjectJson(join(wallpaperDir, id));
  const own = resolveSceneSource(join(wallpaperDir, id), pj);
  if (own.hasPkg) return own;
  const dep = pj && typeof pj === 'object' && !Array.isArray(pj)
    ? (pj as { dependency?: unknown }).dependency
    : undefined;
  if (typeof dep !== 'string') return own;
  const depId = dep.trim();
  if (!depId || !isSafeDependencyId(depId)) return own;
  const depSrc = resolveSceneSource(join(wallpaperDir, depId), readProjectJson(join(wallpaperDir, depId)));
  return depSrc.hasPkg ? depSrc : own;
}
