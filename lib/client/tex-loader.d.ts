import * as THREE from 'three';
export declare const TEX_FORMAT: {
    readonly RGBA8888: 0;
    readonly DXT5: 4;
    readonly DXT3: 6;
    readonly DXT1: 7;
    readonly RG88: 8;
    readonly R8: 9;
};
export declare const FIF: {
    readonly JPEG: 2;
    readonly PNG: 13;
    readonly WEBP: 21;
};
export declare function glFormatForDds(fourCC: string): number;
export interface TexMipmap {
    width: number;
    height: number;
    data: Uint8Array<ArrayBuffer>;
}
export interface TexInfo {
    width: number;
    height: number;
    textureWidth: number;
    textureHeight: number;
    format: number;
    flags: number;
    imageFormat?: number;
    mipmaps: TexMipmap[];
    sprite?: TexSpriteInfo;
}
export interface TexSpriteInfo {
    frames: number;
    cols: number;
    rows: number;
}
export declare function parseTex(buf: Uint8Array): TexInfo | null;
export declare function parseSpriteSection(buf: Uint8Array, pos: number, mipWidth: number, mipHeight: number): TexSpriteInfo | undefined;
export declare function cropToMap(data: Uint8Array<ArrayBuffer>, mipWidth: number, mipHeight: number, mapWidth: number, mapHeight: number, format: number, flags: number): {
    width: number;
    height: number;
    data: Uint8Array<ArrayBuffer>;
};
export type TexRowOrder = 'bottomUp' | 'topDown';
export interface TexLoadOptions {
    alphaPriority?: boolean;
    rowOrder?: TexRowOrder;
}
/** 视频纹理判定（纯函数，node 可测）：flags 带 Video 位 **且** mip0 载荷以 mp4 的 `ftyp` box 开头。 */
export declare function isVideoTexPayload(info: TexInfo): boolean;
export declare function textureFromTex(info: TexInfo, opts?: TexLoadOptions): Promise<THREE.Texture | null>;
export declare function flipCompressedRows(data: Uint8Array, width: number, height: number, blockSize: number): Uint8Array<ArrayBuffer>;
export declare function convertUnormToRgba(data: Uint8Array, format: number, alphaPriority?: boolean): Uint8Array<ArrayBuffer>;
export declare function flipRows(data: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array<ArrayBuffer>;
export declare function loadTexTexture(url: string, opts?: TexLoadOptions): Promise<THREE.Texture | null>;
