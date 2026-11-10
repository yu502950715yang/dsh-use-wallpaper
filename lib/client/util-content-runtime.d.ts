import * as THREE from 'three';
export interface UtilContentCover {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
}
export interface UtilContentHostView {
    sceneWidth: number;
    sceneHeight: number;
    viewWidth: number;
    viewHeight: number;
}
export declare class UtilContentRuntime {
    private readonly entries;
    /** 登记 util 内容条目（内容 mesh 与快照内容区域的世界锚点）；solid 不登记（纯色内容不被替换）。 */
    register(objectId: number, mesh: THREE.Mesh, centerX: number, centerY: number): void;
    setTexture(objectId: number, texture: THREE.Texture, opts?: {
        cover?: UtilContentCover;
    }): void;
    /** 测试/诊断：util 内容当前纹理；solid / 非 util → null。 */
    textureForTest(objectId: number): THREE.Texture | null;
    /** 测试/诊断：util 内容当前的快照覆盖矩形（内容 mesh UV 空间）。 */
    uvForTest(objectId: number): UtilContentCover | null;
    has(objectId: number): boolean;
    clear(): void;
    coverFor(objectId: number, view: UtilContentHostView): UtilContentCover | null;
    private applyCover;
}
