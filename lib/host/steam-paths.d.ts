import type { SteamPathCandidate, WallpaperPathKind } from '../shared/types.js';
export type CandidateKind = WallpaperPathKind;
export interface SteamPathsInput {
    /** 注册表读到的 Steam 安装路径（undefined = 未找到） */
    steamPath?: string;
    /** libraryfolders.vdf 原文（undefined = 不可读/不存在） */
    vdfText?: string;
    /** 额外常见安装根目录 */
    extraRoots?: string[];
}
export interface SteamProbeDeps extends SteamPathsInput {
    /** 读取 vdf 的注入函数（默认按 steamPath 拼接读取） */
    readVdf?: (steamInstall: string) => string | undefined;
    /** 额外常见安装根目录 */
    extraRoots?: string[];
}
export interface ProbeResult {
    workshop: SteamPathCandidate[];
    assets: SteamPathCandidate[];
}
/** 常见 Steam 安装根目录（Windows 默认位置），探测兜底。 */
export declare const DEFAULT_STEAM_ROOTS: readonly string[];
/** 解析 libraryfolders.vdf 原文，返回全部库路径（反转义 \\ → \）。 */
export declare function parseLibraryFoldersVdf(vdf: string): string[];
/**
 * 汇总全部候选 Steam 根目录：注册表安装路径（本身即一个库）、
 * vdf 库列表、常见根目录；按 Windows 大小写不敏感去重。
 */
export declare function collectSteamRoots(input: SteamPathsInput): string[];
/** 由根目录生成壁纸 workshop 目录候选。 */
export declare function collectWorkshopCandidates(roots: string[]): string[];
/** 由根目录生成引擎 assets 目录候选。 */
export declare function collectAssetsCandidates(roots: string[]): string[];
/** 为候选路径标记存在性（目录是否真实存在）。 */
export declare function toCandidates(paths: string[], kind: CandidateKind): SteamPathCandidate[];
/**
 * 读取注册表 HKCU\Software\Valve\Steam 的 SteamPath（Steam 安装目录）。
 * 通过注入的命令执行器运行 `reg query`（Windows 原生；测试注入 fake）。
 * @param run - 执行器，返回 { status, stdout }；null 表示执行不可用（非 Windows 等）。
 */
export declare function readSteamInstallPathFromRegistry(run?: (cmd: string, args: string[]) => {
    status: number;
    stdout: string;
} | null): string | undefined;
/**
 * 组装完整探测结果：收集根目录 → 生成两类候选 → 标记存在性。
 * readVdf 未注入时按 steamPath + '/libraryfolders.vdf' 尝试读取（可能不存在）。
 */
export declare function probeSteamPaths(deps: SteamProbeDeps): ProbeResult;
