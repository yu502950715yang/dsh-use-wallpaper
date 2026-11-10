import * as THREE from 'three';
import type { PuppetInstance } from './puppet.js';
export interface IsolatedObject {
    /** 键 = scene.json 的**对象 id**（不是本类图层的计数器 id，见 attachIsolated 注释）。 */
    id: number;
    kind: 'background' | 'particle' | 'puppet';
    rt: THREE.WebGLRenderTarget;
    rtWidth: number;
    rtHeight: number;
    rtTexture: THREE.Texture;
    localScene: THREE.Scene;
    localCamera: THREE.OrthographicCamera;
    /** 合成 quad（puppet 条目也建，但**不加入主场景**：只承载世界位置/旋转给 effectScreenMatrix 与释放）。 */
    quad: THREE.Mesh;
    /** 合成 quad 是否真的挂在主场景（puppet = false）。 */
    quadAttached: boolean;
    /** puppet 条目：效果链输出要写回它的材质 map（见 setObjectOutput）。 */
    puppet?: PuppetInstance;
    /** 合成 quad 的世界尺寸（= |对象 size/dist × scale|，未钳制幅值），resize 重建几何时用。 */
    worldW: number;
    worldH: number;
}
export interface AttachIsolatedDeps {
    sceneWidth: number;
    sceneHeight: number;
    screenScale: number;
    scene: THREE.Scene;
    isolated: Map<number, IsolatedObject>;
}
export interface AttachIsolatedArgs {
    objectId: number;
    kind: 'background' | 'particle' | 'puppet';
    content: THREE.Object3D;
    worldW: number;
    worldH: number;
    size: {
        width: number;
        height: number;
    };
    position: {
        x: number;
        y: number;
        z: number;
    };
    quadAngles: [number, number, number];
    colorBlendMode: number;
    /** 宿主对象的唯一绘制序（= objects 下标，调用方透传）；缺省按 kind 回退（背景 0 / 粒子 1）。 */
    renderOrder?: number;
    compositeOpacity?: number;
    attachQuad?: boolean;
    puppet?: PuppetInstance;
}
export declare function attachIsolated(deps: AttachIsolatedDeps, args: AttachIsolatedArgs): void;
