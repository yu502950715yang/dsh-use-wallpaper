export type WallpaperKind = 'scene' | 'video' | 'web' | 'image' | 'preset' | 'unknown';
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
    /** 场景包内入口 json 名（WE 模板可能是 gifscene.json 等自定义名；仅 hasScene 时下发）。 */
    sceneEntry?: string;
    /** WE 预设壁纸（dependency）的依赖 id：type='preset' 时存在，场景资源与属性都来自该壁纸。 */
    presetOf?: string;
    previewUrl: string;
}
export interface PkgEntry {
    name: string;
    offset: number;
    size: number;
}
export type UserPropertyValue = boolean | number | string;
export interface UserBindingRef {
    name: string;
    condition?: string;
}
interface UserPropertyBase {
    key: string;
    label: string;
    order: number;
    usedBy: string[];
    condition?: string;
}
export type WallpaperUserProperty = (UserPropertyBase & {
    type: 'bool';
    value: boolean;
}) | (UserPropertyBase & {
    type: 'slider';
    value: number;
    min: number;
    max: number;
    step?: number;
    precision?: number;
    fraction?: boolean;
}) | (UserPropertyBase & {
    type: 'color';
    value: string;
}) | (UserPropertyBase & {
    type: 'combo';
    value: string;
    options: Array<{
        label: string;
        value: string;
    }>;
});
export interface VisibleBinding {
    kind: 'plain' | 'user' | 'script';
    value: boolean;
    key?: string;
    condition?: string;
    script?: string;
    scriptProperties?: Record<string, unknown>;
}
export type ObjectScriptProperty = 'angles' | 'origin' | 'scale' | 'color';
export type TimelineProperty = 'alpha' | 'origin' | 'scale' | 'angles' | 'color';
export interface TimelineKeyframeHandle {
    x: number;
    y: number;
    enabled: boolean;
}
export interface TimelineKeyframe {
    frame: number;
    value: number;
    front?: TimelineKeyframeHandle;
    back?: TimelineKeyframeHandle;
}
export interface TimelineAnimation {
    property: TimelineProperty;
    channels: TimelineKeyframe[][];
    fps: number;
    frameCount: number;
    duration: number;
    mode: 'single' | 'loop' | 'mirror';
    startPaused: boolean;
    relative: boolean;
    wrapLoop: boolean;
    name: string;
    parentKey: TimelineProperty | null;
    childrenKeys: TimelineProperty[];
}
export interface ObjectScriptEntry {
    property: ObjectScriptProperty;
    script: string;
    scriptProperties?: Record<string, unknown>;
}
export interface ObjectUserRefs {
    color?: UserBindingRef;
    alpha?: UserBindingRef;
    brightness?: UserBindingRef;
    origin?: UserBindingRef;
    scale?: UserBindingRef;
    angles?: UserBindingRef;
}
export interface SceneObjectBase {
    /** 对象字段的 user 绑定引用（静态值仍在原字段；装配前由 resolveSceneUserBindings 覆盖）。 */
    userRefs?: ObjectUserRefs;
    /** WE 对象级视差深度（scene.json `parallaxDepth`，两根轴）；缺省 = OWE 的 {0,0} ⇒ 不参与视差。 */
    parallaxDepth?: [number, number];
    /** 对象级属性脚本（angles/origin/scale/color 可各有一个）；visible.script 走 VisibleBinding。 */
    objectScripts?: ObjectScriptEntry[];
    /** 属性时间线动画（alpha/origin/scale/angles/color 可各一条）；见 client/scene-timeline.ts。 */
    animations?: Partial<Record<TimelineProperty, TimelineAnimation>>;
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
    /** WE image 实例声明（scene.json `instance`）：实例纹理槽 + 系统用户纹理（`$mediaThumbnail` = 封面）。 */
    instance?: {
        textures?: string[];
        usertextures?: Array<{
            name: string;
            type: string;
        }>;
    };
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
/** WE util 层四种类型：项目层 / 全屏层 / 合成层 / 纯色层（v0.8.2 F2 按 image 文件名映射）。 */
export type UtilLayerKind = 'project' | 'fullscreen' | 'compose' | 'solid';
export interface SceneUtilObject extends SceneObjectBase {
    kind: 'util';
    id: number;
    name: string;
    layerKind: UtilLayerKind;
    origin: [number, number, number];
    scale: [number, number, number];
    parent?: number;
    angles?: [number, number, number];
    size?: [number, number];
    image: string;
    color?: [number, number, number];
    alpha?: number;
    brightness?: number;
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
    alpha?: number;
    brightness?: number;
    anchor?: string;
    limitwidth?: boolean;
    maxwidth?: number;
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
    /** general.bloom 的 user 绑定（解析期保留，装配前由 resolveSceneUserBindings 决定是否产出 bloom）。 */
    bloomUser?: UserBindingRef;
    /** general.cameraparallax 的 user 绑定（同上：装配前覆盖 parallax.enabled）。 */
    parallaxUser?: UserBindingRef;
    /** 相机视差总配置（scene.json `general.cameraparallax*`，缺省全 0）。 */
    parallax: ParallaxConfig;
    objects: SceneObject[];
    sounds?: SceneSoundObject[];
}
export {};
