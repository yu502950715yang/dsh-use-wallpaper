export declare const MDL_VERTEX_STRIDE = 80;
export interface MdlMesh {
    positions: Float32Array;
    uvs: Float32Array;
    blendIndices: Uint16Array | null;
    blendWeights: Float32Array | null;
    indices: Uint16Array;
    vertexCount: number;
    materialPath: string;
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
} | {
    ok: false;
    error: string;
};
export declare function parseMdl(buf: Uint8Array): MdlParseResult;
