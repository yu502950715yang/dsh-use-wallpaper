import * as THREE from 'three';
export interface TextTextureOptions {
    font?: string;
    pointsize?: number;
    color?: [number, number, number];
    width: number;
    height: number;
}
export declare function textCanvasSize(text: string, pointsize: number | undefined, size?: [number, number]): {
    w: number;
    h: number;
};
export declare function createTextTexture(text: string, opts: TextTextureOptions): THREE.CanvasTexture;
