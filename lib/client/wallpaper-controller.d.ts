import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
export interface SceneRendererLike {
    render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
    dispose?(): void;
    setPaused?(paused: boolean): void;
    setQualityScale?(scale: number): void;
    setGlow?(patch: {
        enabled?: boolean;
        threshold?: number;
        strength?: number;
    }): void;
}
export interface WallpaperControllerOptions {
    fetchList: () => Promise<WallpaperInfo[]>;
    sceneRenderer?: SceneRendererLike;
}
export declare function createWallpaperController(layer: BackgroundLayer, opts: WallpaperControllerOptions): {
    load: () => Promise<WallpaperInfo[]>;
    select: (id: string) => Promise<void>;
};
