import * as THREE from 'three';
import type { TextScriptBinding } from './text-script.js';
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
export declare function drawTextToCanvas(canvas: HTMLCanvasElement, text: string, opts: TextTextureOptions): void;
export declare function createTextTexture(text: string, opts: TextTextureOptions): THREE.CanvasTexture;
export interface ClockDriver {
    /** 文本变化时重绘 canvas 并返回 true（调用方据此置 texture.needsUpdate）。 */
    update(now: Date): boolean;
}
export declare function createScriptDriver(canvas: HTMLCanvasElement, opts: TextTextureOptions, binding: TextScriptBinding, initialText?: string): ClockDriver;
export declare function createClockDriver(canvas: HTMLCanvasElement, opts: TextTextureOptions, props: Record<string, unknown>, initialText: string): ClockDriver;
