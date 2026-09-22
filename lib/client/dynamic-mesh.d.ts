import * as THREE from 'three';
/** 顶点布局：各 attribute 在 stride 内的 float 偏移。 */
export interface VertexLayout {
    stride: number;
    position: number;
    uv: number;
    color: number;
}
/** 本期只支持实测到的那一种组合；其余返回 null（调用方跳过该 mesh 并 warn 一次）。 */
export declare function resolveVertexLayout(vertexFormat: number[]): VertexLayout | null;
/**
 * 推断实际使用的 quad 数。
 *
 * 脚本不告知 count，但它用 `vertices.fill(0, count*36, previous*36)` 清尾、且 quad() 不会产出
 * 「四个顶点 position 全 0」的退化 quad ⇒ 取最后一个非空 quad 的下标 + 1。
 * ⚠️ 这是本模块唯一的启发式：若将来遇到不清尾的脚本（复用旧数据），要改为按 applyData 的
 * 参数长度推断。
 */
export declare function inferQuadCount(buffer: Float32Array, layout: VertexLayout, capacity: number): number;
export interface DynamicModelSpec {
    capacity: number;
    vertexFormat: number[];
    materialPath: string | null;
}
export interface DynamicMeshRegistryOptions {
    parent: THREE.Object3D;
    materialFor: (materialPath: string | null) => THREE.Material;
    onWarn?: (msg: string) => void;
}
/** 运行时网格注册表：脚本 createModelData → 几何体；createLayer → Mesh；applyData → 每帧写顶点。 */
export declare class DynamicMeshRegistry {
    private readonly parent;
    private readonly materialFor;
    private readonly onWarn;
    private readonly models;
    private readonly layers;
    /** 已解析完成的材质（按资产路径）。脚本 init 期就建层，而材质解析是异步的 ⇒ 必须支持回填。 */
    private readonly materialOverrides;
    private nextModelId;
    private nextLayerId;
    private unsupported;
    private warnedUnsupported;
    constructor(opts: DynamicMeshRegistryOptions);
    get modelCount(): number;
    get unsupportedCount(): number;
    createModel(spec: DynamicModelSpec): number | null;
    createLayer(modelId: number, name: string): number;
    applyData(modelId: number, buffer: Float32Array): void;
    /**
     * 材质解析完成后回填：替换**所有已建**（以及后续新建）mesh 上该路径的材质。
     *
     * 必须支持回填 —— 脚本在 init 期就调 createLayer，而材质 json 与 .tex 的解码是异步的，
     * 早于它不可能完成；没有这条通道，所有网格都会永久停在兜底白图材质上（真机现象：
     * 粒子渲染成一堆硬边白色方块）。
     */
    setMaterialForPath(materialPath: string, material: THREE.Material): void;
    setVisible(layerId: number, visible: boolean): void;
    isVisible(layerId: number): boolean;
    geometryOf(modelId: number): THREE.BufferGeometry | null;
    meshOf(layerId: number): THREE.Mesh | null;
    dispose(): void;
}
