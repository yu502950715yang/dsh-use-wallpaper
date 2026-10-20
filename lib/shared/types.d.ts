export type WallpaperKind = 'scene' | 'video' | 'web' | 'image' | 'unknown';
export type WallpaperPathKind = 'workshop' | 'assets';
export interface SteamPathCandidate {
    path: string;
    exists: boolean;
    kind: WallpaperPathKind;
}
export interface ProbeResult {
    workshop: SteamPathCandidate[];
    assets: SteamPathCandidate[];
}
export interface WallpaperInfo {
    id: string;
    title: string;
    type: WallpaperKind;
    file?: string;
    hasPreviewGif: boolean;
    hasScene: boolean;
    previewUrl: string;
}
export interface PkgEntry {
    name: string;
    offset: number;
    size: number;
}
export interface WallpaperUserProperty {
    key: string;
    label: string;
    type: 'bool';
    value: boolean;
    order: number;
}
export interface VisibleBinding {
    kind: 'plain' | 'user' | 'script';
    value: boolean;
    key?: string;
    script?: string;
    scriptProperties?: Record<string, unknown>;
}
export interface SceneObjectBase {
    /** WE 对象级视差深度（scene.json `parallaxDepth`，两根轴）；缺省 = OWE 的 {0,0} ⇒ 不参与视差。 */
    parallaxDepth?: [number, number];
    /** 对象级脚本（angles/origin/scale/color 的 `{script, value}` 包装，优先级同字段顺序）； */
    /** visible.script 之外的脚本入口，如 3765967112 的日夜切换图标（angles.script）。 */
    objectScript?: string;
    objectScriptProperties?: Record<string, unknown>;
}
export interface SceneImageObject extends SceneObjectBase {
    kind: 'image';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    parent?: number;
    angles?: [number, number, number];
    size?: [number, number];
    image: string;
    visible?: VisibleBinding;
    alignment?: string;
    effects?: unknown[];
    script?: string;
    scriptProperties?: Record<string, unknown>;
    color?: [number, number, number];
    alpha?: number;
    brightness?: number;
    colorBlendMode?: number;
    /** WE 动画层（scene.json `animationlayers`）：animation = MDLA 动画 id；visible=false 表示不应用。 */
    animationLayers?: Array<{
        id: number;
        animation: number;
        rate: number;
        blend: number;
        visible: boolean;
    }>;
}
export interface SceneParticleObject extends SceneObjectBase {
    kind: 'particle';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    parent?: number;
    angles?: [number, number, number];
    particle: string;
    visible?: VisibleBinding;
    alignment?: string;
    effects?: unknown[];
    instanceOverrideJson?: string;
}
export interface SceneUtilObject extends SceneObjectBase {
    kind: 'util';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    parent?: number;
    angles?: [number, number, number];
    size?: [number, number];
    image: string;
    visible?: VisibleBinding;
    effects?: unknown[];
}
export interface SceneTextObject extends SceneObjectBase {
    kind: 'text';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    parent?: number;
    angles?: [number, number, number];
    size?: [number, number];
    text: string;
    visible?: VisibleBinding;
    font?: string;
    pointsize?: number;
    color?: [number, number, number];
    alignment?: string;
    horizontalAlign?: string;
    verticalAlign?: string;
    padding?: number;
    script?: string;
    scriptProperties?: Record<string, unknown>;
    effects?: unknown[];
}
export type SceneObject = SceneImageObject | SceneParticleObject | SceneUtilObject | SceneTextObject;
/** WE 相机视差配置（scene.json `general.cameraparallax*`；缺省全关/全 0，= OWE 解析器缺省）。 */
export interface ParallaxConfig {
    enabled: boolean;
    amount: number;
    delay: number;
    mouseInfluence: number;
}
/** WE 音频对象（scene.json object.sound）：多文件 + 音量 + 播放模式（对齐 OWE SoundParser）。 */
export interface SceneSoundObject {
    files: string[];
    volume: number;
    playbackmode: 'loop' | 'random' | 'single';
}
export interface SceneDescription {
    camera: {
        center: [number, number, number];
        eye: [number, number, number];
        up: [number, number, number];
    };
    orthogonal: {
        width: number;
        height: number;
    };
    fov?: number;
    perspectiveOverrideFov?: number;
    /** 清屏色（scene.json `general.clearcolor`，已归一化到 0-255）。 */
    clearColor?: [number, number, number];
    /** 壁纸级 bloom（WE general.bloom*，`bloom:true` 才产出；v0.8.1 只支持 threshold/strength）。 */
    bloom?: {
        strength: number;
        threshold: number;
    };
    /** 相机视差总配置（scene.json `general.cameraparallax*`，缺省全 0）。 */
    parallax: ParallaxConfig;
    objects: SceneObject[];
    sounds?: SceneSoundObject[];
}
