export type WallpaperKind = 'scene' | 'video' | 'web' | 'image' | 'unknown';
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
export interface SceneImageObject {
    kind: 'image';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    image: string;
}
export interface SceneParticleObject {
    kind: 'particle';
    id: number;
    name: string;
    origin: [number, number, number];
    scale: [number, number, number];
    particle: string;
}
export type SceneObject = SceneImageObject | SceneParticleObject;
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
}
