// 插件 HTTP 路由契约（审查 P0-11）：host 注册与 client 请求**共用同一份常量/构造器**。
// 变更路径必须只改这里；`tests/route-contract.test.ts` 断言 host 注册集合与常量一致，
// 并禁止 client 再出现裸 '/wallpapers/' 字面量。
export const WALLPAPER_PREFIX = '/wallpapers';
export const WALLPAPER_ROUTES = {
    list: `${WALLPAPER_PREFIX}/list`,
    /** prefix */
    media: `${WALLPAPER_PREFIX}/media`,
    /** prefix */
    scene: `${WALLPAPER_PREFIX}/scene`,
    /** prefix */
    frame: `${WALLPAPER_PREFIX}/frame`,
    /** prefix（wasm/quickjs 静态产物；也是 client 的 STATIC_BASE） */
    static: `${WALLPAPER_PREFIX}/static`,
    /** prefix */
    web: `${WALLPAPER_PREFIX}/web`,
    particleTexture: `${WALLPAPER_PREFIX}/particle-texture`,
    probe: `${WALLPAPER_PREFIX}/probe`,
    nowPlaying: `${WALLPAPER_PREFIX}/now-playing`,
    nowPlayingThumbnail: `${WALLPAPER_PREFIX}/now-playing/thumbnail`,
    properties: `${WALLPAPER_PREFIX}/properties`,
    bootLocalVideo: `${WALLPAPER_PREFIX}/boot/local-video`,
    bootProbe: `${WALLPAPER_PREFIX}/boot/probe`,
};
/** 全部注册路径（含 prefix 根）；`tests/route-contract.test.ts` 与 host 注册表比对。 */
export const WALLPAPER_ROUTE_PATHS = Object.values(WALLPAPER_ROUTES);
const enc = encodeURIComponent;
export function wallpaperListUrl(refresh = false) {
    return refresh ? `${WALLPAPER_ROUTES.list}?refresh=1` : WALLPAPER_ROUTES.list;
}
export function bootLocalVideoUrl(path) {
    return `${WALLPAPER_ROUTES.bootLocalVideo}?path=${enc(path)}`;
}
export function bootProbeUrl(path) {
    return `${WALLPAPER_ROUTES.bootProbe}?path=${enc(path)}`;
}
/** 场景素材：pkg 内条目名（asset）或 action（video-probe / embedded-video）。 */
export function sceneAssetUrl(id, name) {
    return `${WALLPAPER_ROUTES.scene}/${enc(id)}/asset?name=${enc(name)}`;
}
export function sceneActionUrl(id, action) {
    return `${WALLPAPER_ROUTES.scene}/${enc(id)}/${action}`;
}
/** 视频壁纸文件 / 预览图（prefix /media）。 */
export function mediaFileUrl(id) {
    return `${WALLPAPER_ROUTES.media}/${enc(id)}/file`;
}
export function mediaPreviewUrl(id) {
    return `${WALLPAPER_ROUTES.media}/${enc(id)}/preview`;
}
/**
 * web 壁纸入口文件：`project.json.file` 未必是 index.html（实测 `3818900270` 荷塘观鱼 = wallpaper.html，
 * 与 §5.53 的 scene 入口同一类问题）。只放行壁纸目录内的相对路径——含 '..' 的段会被 WHATWG URL
 * 规范化折叠到宿主其它路由；非法/缺失回退 index.html（旧行为）。
 */
export function resolveWebEntryPath(file) {
    const raw = typeof file === 'string' ? file.trim().replace(/\\/g, '/') : '';
    if (!raw)
        return 'index.html';
    const segs = raw.split('/');
    // 只接受字母/数字/._- 段：空格与 ?#% 等会让 URL 解析错位，host 路由也不解码百分号转义
    if (segs.some((s) => !s || s === '.' || s === '..' || !/^[A-Za-z0-9._-]+$/.test(s)))
        return 'index.html';
    return segs.join('/');
}
/** web 壁纸静态文件（prefix /web）。 */
export function webWallpaperUrl(id, file) {
    return `${WALLPAPER_ROUTES.web}/${enc(id)}/${resolveWebEntryPath(file)}`;
}
/** 首帧抓帧缓存（prefix /frame；GET 读、POST 写）。 */
export function frameUrl(id) {
    return `${WALLPAPER_ROUTES.frame}/${enc(id)}`;
}
/** 引擎 assets 纹理（name 可带子目录；可选 id 用于限定壁纸包）。 */
export function particleTextureUrl(opts) {
    const idPart = opts.id !== undefined ? `id=${enc(opts.id)}&` : '';
    return `${WALLPAPER_ROUTES.particleTexture}?${idPart}name=${enc(opts.name)}`;
}
export function nowPlayingUrl(pageTitle) {
    return `${WALLPAPER_ROUTES.nowPlaying}?title=${enc(pageTitle)}`;
}
export function nowPlayingThumbnailUrl(rev) {
    return `${WALLPAPER_ROUTES.nowPlayingThumbnail}?rev=${enc(String(rev))}`;
}
const STATIC_FILES = {
    wasmModule: 'we_scene_wasm.js',
    wasmBinary: 'we_scene_wasm_bg.wasm',
    quickjs: 'quickjs.wasm',
};
/** 静态产物（wasm / quickjs）的 URL；host 的 /static 前缀。 */
export function staticUrl(file) {
    return `${WALLPAPER_ROUTES.static}/${STATIC_FILES[file]}`;
}
