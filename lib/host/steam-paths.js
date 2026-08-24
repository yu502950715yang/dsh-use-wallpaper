// src/host/steam-paths.ts —— Wallpaper Engine 目录自动探测。
// 目标：不再依赖写死的 D:/Steam 路径。从三处来源收集候选 Steam 根目录：
//   1. 注册表 HKCU\Software\Valve\Steam 的 SteamPath（Steam 安装目录）
//   2. libraryfolders.vdf（Steam 安装目录下，列出全部 Steam 库路径）
//   3. 常见安装根目录（C:/Program Files (x86)/Steam、D:/Steam 等）
// 再由每个根生成壁纸目录候选（steamapps/workshop/content/431960）与
// 引擎目录候选（steamapps/common/wallpaper_engine），并按存在性标记。
// I/O（注册表、vdf 读取）经参数注入，纯逻辑可单测。
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, sep } from 'node:path';
/** 常见 Steam 安装根目录（Windows 默认位置），探测兜底。 */
export const DEFAULT_STEAM_ROOTS = [
    'C:/Program Files (x86)/Steam',
    'D:/Steam',
    'E:/Steam',
];
// 正则提取 vdf 中所有 "path" "..." 条目（键与值之间可有可无空白）；vdf 内路径以 \\ 转义。
const VDF_PATH_RE = /"path"\s*"([^"]+)"/g;
/** 解析 libraryfolders.vdf 原文，返回全部库路径（反转义 \\ → \）。 */
export function parseLibraryFoldersVdf(vdf) {
    const out = [];
    for (const m of vdf.matchAll(VDF_PATH_RE)) {
        out.push(m[1].replace(/\\\\/g, '\\'));
    }
    return out;
}
/** 归一化路径分隔符（/ 与 \ 视为同一路径）后小写，Windows 大小写不敏感。 */
const normPath = (p) => p.replace(/[\\/]/g, sep);
/** 去重（Windows 大小写不敏感、分隔符无关），输出统一分隔符路径，保留首次出现顺序。 */
function dedupePaths(paths) {
    const seen = new Set();
    const out = [];
    for (const p of paths) {
        const key = normPath(p).toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(normPath(p));
    }
    return out;
}
/**
 * 汇总全部候选 Steam 根目录：注册表安装路径（本身即一个库）、
 * vdf 库列表、常见根目录；按 Windows 大小写不敏感去重。
 */
export function collectSteamRoots(input) {
    const roots = [];
    if (input.steamPath)
        roots.push(input.steamPath);
    if (input.vdfText)
        roots.push(...parseLibraryFoldersVdf(input.vdfText));
    if (input.extraRoots)
        roots.push(...input.extraRoots);
    return dedupePaths(roots);
}
/** 由根目录生成壁纸 workshop 目录候选。 */
export function collectWorkshopCandidates(roots) {
    return roots.map((r) => join(r, 'steamapps', 'workshop', 'content', '431960'));
}
/** 由根目录生成引擎 assets 目录候选。 */
export function collectAssetsCandidates(roots) {
    return roots.map((r) => join(r, 'steamapps', 'common', 'wallpaper_engine'));
}
/** 为候选路径标记存在性（目录是否真实存在）。 */
export function toCandidates(paths, kind) {
    return paths.map((p) => ({ path: p, exists: existsSync(p), kind }));
}
/**
 * 读取注册表 HKCU\Software\Valve\Steam 的 SteamPath（Steam 安装目录）。
 * 通过注入的命令执行器运行 `reg query`（Windows 原生；测试注入 fake）。
 * @param run - 执行器，返回 { status, stdout }；null 表示执行不可用（非 Windows 等）。
 */
export function readSteamInstallPathFromRegistry(run) {
    const exec = run ?? ((cmd, args) => {
        try {
            const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true });
            return { status: r.status ?? 1, stdout: r.stdout ?? '' };
        }
        catch {
            return null;
        }
    });
    const r = exec('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath']);
    if (!r || r.status !== 0)
        return undefined;
    // 输出形如 "    SteamPath    REG_SZ    D:\Steam"；取 REG_SZ 之后的值并去空白。
    const m = /REG_SZ\s+(\S.*)$/m.exec(r.stdout);
    return m?.[1]?.trim() || undefined;
}
/**
 * 组装完整探测结果：收集根目录 → 生成两类候选 → 标记存在性。
 * readVdf 未注入时按 steamPath + '/libraryfolders.vdf' 尝试读取（可能不存在）。
 */
export function probeSteamPaths(deps) {
    let vdfText = deps.vdfText;
    if (vdfText === undefined && deps.steamPath && deps.readVdf) {
        vdfText = deps.readVdf(deps.steamPath);
    }
    const roots = collectSteamRoots({ steamPath: deps.steamPath, vdfText, extraRoots: deps.extraRoots });
    return {
        workshop: toCandidates(collectWorkshopCandidates(roots), 'workshop'),
        assets: toCandidates(collectAssetsCandidates(roots), 'assets'),
    };
}
