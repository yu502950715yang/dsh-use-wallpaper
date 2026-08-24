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
}
export declare function parseTex(buf: Uint8Array): TexInfo | null;
export declare function textureFromTex(info: TexInfo): Promise<THREE.Texture | null>;
export declare function flipRows(data: Uint8Array, width: number, height: number, bytesPerPixel: number): Uint8Array<ArrayBuffer>;
export declare function loadTexTexture(url: string): Promise<THREE.Texture | null>;
