import { PkgReader } from './pkg-reader.js';
export interface WallpaperRoutesOptions {
    /** 兼容旧调用：静态 wallpaperDir（无 state 时使用） */
    wallpaperDir?: string;
    staticDir?: string;
    /** 兼容旧调用：静态 weAssetsDir（无 state 时使用） */
    weAssetsDir?: string;
    /** 可变运行状态：每次请求读取实时值（host/index.ts 维护，settings 热更新） */
    state?: {
        wallpaperDir: string;
        weAssetsDir: string;
    };
}
export declare function getPkgReader(pkgPath: string): PkgReader;
export declare function isSafeAssetName(name: string): boolean;
/** 解析「引擎目录 + VFS 相对路径」，并证明结果没有跳出 `<weAssetsDir>/assets`（resolve + 前缀比较，
 *  与本文件其它路由同一手法）。越界 / 不存在 / 不是文件 → null（调用方按未命中继续）。 */
export declare function resolveEngineAsset(weAssetsDir: string, name: string): string | null;
export declare function registerWallpaperRoutes(ctx: any, opts: WallpaperRoutesOptions): void;
