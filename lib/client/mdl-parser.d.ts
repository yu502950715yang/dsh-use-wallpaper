export declare const MDL_VERTEX_STRIDE = 80;
/** stride 命中原因（闭集，Task 7 可穷尽检查）。 */
export type MdlStrideReason = 'packed-80' | 'tight-coverage' | 'waste-too-high' | 'ambiguous' | 'no-candidate' | 'layout-unknown';
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
    reason: MdlStrideReason;
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
    /** stride 判定痕迹（可选：接口加法）；成功路径必填，Task 7 排查用 */
    strideInfo?: MdlStrideInfo;
}
export interface MdlBone {
    /** bones 数组下标（文件 id 非 0..n-1 时已重排，见 MdlPuppet.boneIdMapping） */
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
    /** bones 数组下标（= MdlBone.index；文件里的 id 已映射到下标） */
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
/** 段级状态：absent = 没有段标记；ok = 段解析完整；failed = 段在但没解完。 */
export type MdlSegmentState = 'absent' | 'ok' | 'failed';
/** 段级诊断：区分「段不存在」与「段存在但解析失败」（Task 8 用）。 */
export interface MdlSegmentsInfo {
    mdls: MdlSegmentState;
    mdla: MdlSegmentState;
}
/** 骨骼 id 口径：'identity' = 文件 id 就是下标；'remapped' = 已按文件 id 升序重排。 */
export type MdlBoneIdMapping = 'identity' | 'remapped';
export interface MdlPuppet {
    version: string;
    mesh: MdlMesh;
    bones: MdlBone[];
    animations: MdlAnimation[];
    /** 段级诊断（可选：接口加法）；T8 据此区分「无动画」与「动画解析失败」 */
    segments?: MdlSegmentsInfo;
    /** 骨骼 id 口径（可选：接口加法）；'remapped' 表示父索引与轨 boneId 已同步映射到下标 */
    boneIdMapping?: MdlBoneIdMapping;
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
