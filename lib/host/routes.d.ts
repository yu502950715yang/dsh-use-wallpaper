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
export declare function registerWallpaperRoutes(ctx: any, opts: WallpaperRoutesOptions): void;
