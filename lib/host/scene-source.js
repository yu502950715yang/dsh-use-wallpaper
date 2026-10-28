import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const DEFAULT_ENTRY = 'scene.json';
const DEFAULT_PKG = 'scene.pkg';
// file 是 pkg 内入口条目名：必须是包内相对路径（非绝对、无 ..），否则按缺省处理。
function isSafeEntry(file) {
    if (file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:/.test(file))
        return false;
    return !file.split(/[\\/]+/).includes('..');
}
export function resolveSceneSource(resDir, projectJson) {
    let file = '';
    if (projectJson && typeof projectJson === 'object' && !Array.isArray(projectJson)) {
        const raw = projectJson.file;
        if (typeof raw === 'string')
            file = raw.trim();
    }
    if (file && isSafeEntry(file)) {
        const pkgPath = join(resDir, file.replace(/\.[^./\\]*$/, '') + '.pkg');
        if (existsSync(pkgPath))
            return { resDir, pkgPath, entry: file, hasPkg: true };
        // file 指向的包不存在 → 回退标准名（保守，不把素材问题升级成失败）
    }
    const pkgPath = join(resDir, DEFAULT_PKG);
    return { resDir, pkgPath, entry: DEFAULT_ENTRY, hasPkg: existsSync(pkgPath) };
}
function readProjectJson(resDir) {
    try {
        return JSON.parse(readFileSync(join(resDir, 'project.json'), 'utf8'));
    }
    catch {
        return null;
    }
}
function isSafeDependencyId(dep) {
    return /^[A-Za-z0-9._-]+$/.test(dep) && !dep.includes('..');
}
/** 完整解析：自身目录优先；preset（dependency）回退到依赖壁纸目录，入口按依赖自己的 project.json。 */
export function resolveWallpaperSceneSource(wallpaperDir, id, projectJson) {
    const pj = projectJson ?? readProjectJson(join(wallpaperDir, id));
    const own = resolveSceneSource(join(wallpaperDir, id), pj);
    if (own.hasPkg)
        return own;
    const dep = pj && typeof pj === 'object' && !Array.isArray(pj)
        ? pj.dependency
        : undefined;
    if (typeof dep !== 'string')
        return own;
    const depId = dep.trim();
    if (!depId || !isSafeDependencyId(depId))
        return own;
    const depSrc = resolveSceneSource(join(wallpaperDir, depId), readProjectJson(join(wallpaperDir, depId)));
    return depSrc.hasPkg ? depSrc : own;
}
