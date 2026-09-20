export interface SceneGraphNode {
    id: number;
    parent?: number;
    origin?: [number, number, number];
    scale?: [number, number, number];
    angles?: [number, number, number];
}
export interface WorldTransform {
    origin: [number, number, number];
    scale: [number, number, number];
    angles: [number, number, number];
}
export declare function resolveWorldTransforms(nodes: SceneGraphNode[]): Map<number, WorldTransform>;
