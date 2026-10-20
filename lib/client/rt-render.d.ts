import type * as THREE from 'three';
export interface RenderIntoRenderTargetOptions {
    /**
     * 保留 renderer 当前 clear alpha（后处理 baseRT 自渲用：清的是整屏背景色，强制 0 会被
     * premultipliedAlpha 把 RGB 乘成 0）。缺省 false = 透明清屏（对象 RT 不变量）。
     */
    preserveClearAlpha?: boolean;
}
/**
 * 把 `scene` 渲染进 `target`（缺省透明清屏），退出时把渲染目标复位为 null。
 * 返回渲染前的清屏 alpha（供测试断言；renderer 不支持时为 null）。
 */
export declare function renderIntoRenderTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget, scene: THREE.Scene, camera: THREE.Camera, options?: RenderIntoRenderTargetOptions): number | null;
