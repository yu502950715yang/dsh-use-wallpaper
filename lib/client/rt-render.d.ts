import type * as THREE from 'three';
/**
 * 把 `scene` 渲染进 `target`（透明清屏），退出时把渲染目标复位为 null。
 * 返回渲染前的清屏 alpha（供测试断言；renderer 不支持时为 null）。
 */
export declare function renderIntoRenderTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, scene: THREE.Scene, camera: THREE.Camera): number | null;
