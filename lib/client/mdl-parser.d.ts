export declare const MDL_VERTEX_STRIDE = 80;
/** 单个 stride 候选的判定痕迹（Task 7 排查用，不参与渲染）。 */
export interface MdlStrideCandidate {
    stride: number;
    /** vertexBytes / stride（不整除时为 0） */
    vertexCount: number;
    /** vertexBytes % stride === 0 */
    divides: boolean;
    /** 通过「整除 + 顶点数在界内 + 索引零越界」 */
    inRange: boolean;
    /** 浪费率 = 1 − (maxIndex + 1) / vertexCount；未通过 inRange 时为 -1 */
    waste: number;
}
/** 顶点块 stride 是怎么定下来的（Task 7 排查用，不参与渲染）。 */
export interface MdlStrideInfo {
    /** 成功 = 实际用于解码的 stride；失败 = 本会选中的候选（0 = 无候选） */
    stride: number;
    /** 命中原因：'packed-80'（蒙皮族固定）| 'tight-coverage' | 'waste-too-high' | 'ambiguous' | 'no-candidate' */
    reason: string;
    /** 索引缓冲里的最大索引 */
    maxIndex: number;
    /** 候选集全量判定（含被淘汰者与各自浪费率） */
    candidates: MdlStrideCandidate[];
}
export interface MdlMesh {
    positions: Float32Array;
    uvs: Float32Array;
    blendIndices: Uint16Array | null;
    blendWeights: Float32Array | null;
    indices: Uint16Array;
    vertexCount: number;
    materialPath: string;
    /** stride 判定痕迹（选中的 stride + 候选集与浪费率），Task 7 排查用 */
    strideInfo: MdlStrideInfo;
}
export interface MdlBone {
    index: number;
    parent: number;
    bind: Float32Array;
}
export interface MdlKeyframe {
    pos: [number, number, number];
    rot: [number, number, number, number];
    scale: [number, number];
}
export interface MdlTrack {
    boneId: number;
    keys: MdlKeyframe[];
}
export interface MdlAnimation {
    id: number;
    name: string;
    mode: string;
    fps: number;
    frameCount: number;
    tracks: MdlTrack[];
}
export interface MdlPuppet {
    version: string;
    mesh: MdlMesh;
    bones: MdlBone[];
    animations: MdlAnimation[];
}
export type MdlParseResult = {
    ok: true;
    puppet: MdlPuppet;
}
/** strideInfo 只在因 stride 判定而拒收时带上（Task 7 排查用） */
 | {
    ok: false;
    error: string;
    strideInfo?: MdlStrideInfo;
};
export declare function parseMdl(buf: Uint8Array): MdlParseResult;
