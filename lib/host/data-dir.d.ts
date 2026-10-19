/** 数据目录环境变量：设置后覆盖默认位置（迁移 / 测试用）。 */
export declare const DATA_DIR_ENV = "DSH_USE_WALLPAPER_DATA_DIR";
export declare function resolveDataDir(opts?: {
    env?: NodeJS.ProcessEnv;
    home?: string;
}): string;
/** 创建并返回数据目录（幂等）。 */
export declare function ensureDataDir(dir: string): string;
/** 抓帧 PNG 目录。 */
export declare function framesDirOf(dataDir: string): string;
