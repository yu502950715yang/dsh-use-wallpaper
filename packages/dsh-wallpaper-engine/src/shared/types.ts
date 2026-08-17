// src/shared/types.ts —— 跨任务共享类型（Interfaces 原文）

export type WallpaperKind = 'scene' | 'video' | 'web' | 'image' | 'unknown';

export interface WallpaperInfo {
  id: string;                  // workshop id（目录名）
  title: string;
  type: WallpaperKind;
  file?: string;               // project.json 的 file 字段
  hasPreviewGif: boolean;
  hasScene: boolean;           // 存在 scene.pkg
  previewUrl: string;          // `/wallpapers/media/${id}/preview`
}

export interface PkgEntry { name: string; offset: number; size: number; }

export interface SceneImageObject {
  kind: 'image'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  image: string;               // 资源名，如 "models/xxx.json"
}
export interface SceneParticleObject {
  kind: 'particle'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  particle: string;            // 资源名，如 "particles/presets/lightshafts.json"
}
export type SceneObject = SceneImageObject | SceneParticleObject;

export interface SceneDescription {
  camera: { center: [number, number, number]; eye: [number, number, number]; up: [number, number, number] };
  orthogonal: { width: number; height: number };
  clearColor?: [number, number, number];
  objects: SceneObject[];
}
