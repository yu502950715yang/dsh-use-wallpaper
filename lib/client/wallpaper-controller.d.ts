import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundLayer } from './background-layer.js';
export interface WallpaperControllerOptions {
    fetchList: () => Promise<WallpaperInfo[]>;
    sceneRenderer?: {
        render(wallpaperId: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
    };
}
export declare function createWallpaperController(layer: BackgroundLayer, opts: WallpaperControllerOptions): {
    load: () => Promise<WallpaperInfo[]>;
    select: (id: string) => Promise<void>;
};
