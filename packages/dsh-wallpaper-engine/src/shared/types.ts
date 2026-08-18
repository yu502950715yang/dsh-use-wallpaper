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
  size?: [number, number];       // scene.json 的 size 字段（WE 像素尺寸），缺省时由纹理宽高推算
  image: string;                 // 资源名，如 "models/xxx.json"
}
export interface SceneParticleObject {
  kind: 'particle'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  particle: string;            // 资源名，如 "particles/presets/lightshafts.json"
}
// WE 内置合成层/全屏层/项目层对象（image 引用 models/util/*.json，pkg 内无此文件）。
// 语义是效果链容器/控制节点而非纹理：一期不渲染（跳过），effects 字段为二期
// 效果链（shader 后处理）渲染预留。
export interface SceneUtilObject {
  kind: 'util'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  size?: [number, number];       // WE 像素尺寸（与 image 对象一致）
  image: string;                 // 如 "models/util/composelayer.json"
  effects?: unknown[];           // 对象效果链定义（effects 数组，二期使用）
}
export type SceneObject = SceneImageObject | SceneParticleObject | SceneUtilObject;

export interface SceneDescription {
  camera: { center: [number, number, number]; eye: [number, number, number]; up: [number, number, number] };
  orthogonal: { width: number; height: number };
  clearColor?: [number, number, number];
  objects: SceneObject[];
}
