export declare const WALLPAPER_PREFIX = "/wallpapers";
export declare const WALLPAPER_ROUTES: {
    readonly list: "/wallpapers/list";
    /** prefix */
    readonly media: "/wallpapers/media";
    /** prefix */
    readonly scene: "/wallpapers/scene";
    /** prefix */
    readonly frame: "/wallpapers/frame";
    /** prefix（wasm/quickjs 静态产物；也是 client 的 STATIC_BASE） */
    readonly static: "/wallpapers/static";
    /** prefix */
    readonly web: "/wallpapers/web";
    readonly particleTexture: "/wallpapers/particle-texture";
    readonly probe: "/wallpapers/probe";
    readonly nowPlaying: "/wallpapers/now-playing";
    readonly nowPlayingThumbnail: "/wallpapers/now-playing/thumbnail";
    readonly properties: "/wallpapers/properties";
    readonly bootLocalVideo: "/wallpapers/boot/local-video";
    readonly bootProbe: "/wallpapers/boot/probe";
};
/** 全部注册路径（含 prefix 根）；`tests/route-contract.test.ts` 与 host 注册表比对。 */
export declare const WALLPAPER_ROUTE_PATHS: readonly string[];
export declare function wallpaperListUrl(refresh?: boolean): string;
export declare function bootLocalVideoUrl(path: string): string;
export declare function bootProbeUrl(path: string): string;
/** 场景素材：pkg 内条目名（asset）或 action（video-probe / embedded-video）。 */
export declare function sceneAssetUrl(id: string, name: string): string;
export declare function sceneActionUrl(id: string, action: 'video-probe' | 'embedded-video'): string;
/** 视频壁纸文件 / 预览图（prefix /media）。 */
export declare function mediaFileUrl(id: string): string;
export declare function mediaPreviewUrl(id: string): string;
/** web 壁纸静态文件（prefix /web）。 */
export declare function webWallpaperUrl(id: string, file?: string): string;
/** 首帧抓帧缓存（prefix /frame；GET 读、POST 写）。 */
export declare function frameUrl(id: string): string;
/** 引擎 assets 纹理（name 可带子目录；可选 id 用于限定壁纸包）。 */
export declare function particleTextureUrl(opts: {
    name: string;
    id?: string;
}): string;
export declare function nowPlayingUrl(pageTitle: string): string;
export declare function nowPlayingThumbnailUrl(rev: number): string;
declare const STATIC_FILES: Record<string, string>;
/** 静态产物（wasm / quickjs）的 URL；host 的 /static 前缀。 */
export declare function staticUrl(file: keyof typeof STATIC_FILES): string;
export {};
