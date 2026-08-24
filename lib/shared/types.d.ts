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
export interface VisibleBinding {
    kind: 'plain' | 'user' | 'script';
    value: boolean;
    key?: string;
    script?: string;
    scriptProperties?: Record<string, unknown>;
}
export interface SceneImageObject {
    kind: 'image';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
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
}
export interface SceneParticleObject {
    kind: 'particle';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    particle: string;
    visible?: VisibleBinding;
    alignment?: string;
    effects?: unknown[];
}
export interface SceneUtilObject {
    kind: 'util';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    size?: [number, number];
    image: string;
    visible?: VisibleBinding;
    effects?: unknown[];
}
export interface SceneTextObject {
    kind: 'text';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    size?: [number, number];
    text: string;
    visible?: VisibleBinding;
    font?: string;
    pointsize?: number;
    color?: [number, number, number];
    alignment?: string;
    script?: string;
    scriptProperties?: Record<string, unknown>;
}
export type SceneObject = SceneImageObject | SceneParticleObject | SceneUtilObject | SceneTextObject;
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
    clearColor?: [number, number, number];
    objects: SceneObject[];
    sounds?: string[];
}
