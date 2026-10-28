export interface SceneSource {
    /** 提供场景包的目录（preset 时为依赖壁纸目录）。 */
    resDir: string;
    pkgPath: string;
    /** pkg 内场景入口 json 名（WE `project.json.file`；缺省 scene.json）。 */
    entry: string;
    hasPkg: boolean;
}
export declare function resolveSceneSource(resDir: string, projectJson: unknown): SceneSource;
/** 完整解析：自身目录优先；preset（dependency）回退到依赖壁纸目录，入口按依赖自己的 project.json。 */
export declare function resolveWallpaperSceneSource(wallpaperDir: string, id: string, projectJson?: unknown): SceneSource;
