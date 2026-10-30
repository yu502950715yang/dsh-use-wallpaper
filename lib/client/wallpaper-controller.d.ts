import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
import type { HealthSnapshot } from './render-health.js';
import type { MediaFallback } from './media-health.js';
import type { SystemAudioFailure } from './system-audio.js';
export interface SceneRendererLike {
    /** entry = pkg 内场景入口 json 名（WE 模板可能是 gifscene.json；缺省 scene.json）。 */
    render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement, sceneEntry?: string): Promise<boolean>;
    dispose?(): void;
    setPaused?(paused: boolean): void;
    setQualityScale?(scale: number): void;
    setGlow?(patch: {
        enabled?: boolean;
        threshold?: number;
        strength?: number;
    }): void;
    setSoundEnabled?(enabled: boolean): void;
    setMediaIntegration?(enabled: boolean): void;
    startSystemAudio?(): Promise<SystemAudioFailure | 'ok'>;
    stopSystemAudio?(): void;
    setOnContextLost?(cb: ((id: string) => void) | null): void;
    getLastHealth?(): HealthSnapshot | null;
    setOnHealth?(cb: ((s: HealthSnapshot) => void) | null): void;
    captureFrame?(): Promise<Uint8Array | null>;
}
/** 贴壁纸文字样式（设置面板可改）：实时读取，故由 index.ts 以 getter 注入。 */
export interface TextStyleSettings {
    /** 'auto' | 'white' | 'black' | 'custom'（非法值按 auto 处理）。 */
    mode: string;
    /** 自定义色（仅 custom 档使用）。 */
    custom: string;
    /** 描边档位 0-3（0 = 关）。 */
    outline: number;
}
export interface WallpaperControllerOptions {
    fetchList: () => Promise<WallpaperInfo[]>;
    sceneRenderer?: SceneRendererLike;
    /** 文字颜色/描边设置（实时读取）。缺省 = auto 档、无描边（既有行为）。 */
    textStyle?: () => TextStyleSettings;
    /** preview 亮度测量；缺省用 luma.measureLuma（测试注入替身用）。 */
    measurePreviewLuma?: (url: string) => Promise<number | null>;
    /** 视频解码失败（编码不支持/首帧超时）→ 面板提示用；`fallback` 为控制器实际回退的结果。 */
    onMediaFailure?: (id: string, result: 'unsupported' | 'timeout', fallback: MediaFallback) => void;
    /** scene 成功显示后的通知（index 用它触发首帧缓存抓帧）；不得阻塞渲染。 */
    onSceneLive?: (info: WallpaperInfo) => void;
    /** scene 渲染失败/不可用时的降级链（内嵌视频 → 抓帧 → preview）；抛错时控制器落回 preview。 */
    sceneFallback?: (info: WallpaperInfo) => Promise<void>;
}
export declare function createWallpaperController(layer: BackgroundLayer, opts: WallpaperControllerOptions): {
    load: () => Promise<WallpaperInfo[]>;
    select: (id: string) => Promise<void>;
    getList(): WallpaperInfo[];
    applyTextStyle(): void;
};
