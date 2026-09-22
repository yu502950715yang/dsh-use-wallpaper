import type * as THREE from 'three';
export interface LayerWrite {
    origin?: [number, number, number];
    angles?: [number, number, number];
    scale?: [number, number, number];
    alpha?: number;
    visible?: boolean;
    /** `layer.color` 的写入（92000 的粒子着色、94000 的按钮亮度渐变）。
     *  一期**只记录不应用**：隔离对象的颜色语义在对象 RT → 合成 quad 路径下与直接设材质色不等价，
     *  贸然应用会引入新的错误视觉；等有对照样本再定。 */
    color?: [number, number, number];
}
export interface LayerStateTable {
    write(objectId: number, patch: LayerWrite): void;
    read(objectId: number): LayerWrite;
    takeDirty(): Map<number, LayerWrite>;
    size(): number;
}
export declare function createLayerStateTable(): LayerStateTable;
/** 应用器要写到哪个对象上：three 的最终显示对象 + 场景固有尺寸（we_to_three 的基准）。 */
export interface DisplayTarget {
    object: THREE.Object3D;
    sceneW: number;
    sceneH: number;
}
/** 把脏写入应用到 three 对象。返回实际应用的对象数（lookup 未命中的跳过 —— util / 未渲染对象只记账）。
 *
 *  ⚠️ visible=false 或 alpha≈0 走 three 的 `Object3D.visible` —— 这是**对象级隐藏**，**不动**引擎既有
 *  的 scene.json visible 过滤（那会影响其他 28 张壁纸的画面，见 spec §6.1 的零回归决策）。 */
export declare function applyLayerState(dirty: Map<number, LayerWrite>, lookup: (objectId: number) => DisplayTarget | undefined): number;
