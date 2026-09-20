import * as THREE from 'three';
import type { TextScriptBinding } from './text-script.js';
export interface TextTextureOptions {
    font?: string;
    pointsize?: number;
    color?: [number, number, number];
    width: number;
    height: number;
    padding?: number;
    horizontalAlign?: string;
    verticalAlign?: string;
    alignment?: string;
}
export interface TextMeasureOptions {
    font?: string;
    pointsize?: number;
    padding?: number;
    horizontalAlign?: string;
}
export interface TextLayout {
    width: number;
    height: number;
    textWidth: number;
    textHeight: number;
}
export declare function measureTextLayout(text: string, opts?: TextMeasureOptions): TextLayout;
export declare function textCanvasSize(text: string, opts?: TextMeasureOptions): {
    w: number;
    h: number;
};
export interface TextAlignments {
    halign: 'left' | 'center' | 'right';
    valign: 'top' | 'center' | 'bottom';
}
export declare function textAlignments(horizontalAlign?: string, verticalAlign?: string, alignment?: string): TextAlignments;
export declare function textLayerOffset(layout: TextLayout, horizontalAlign: string | undefined, verticalAlign: string | undefined, alignment: string | undefined, scale: readonly number[]): [number, number];
export declare function drawTextToCanvas(canvas: HTMLCanvasElement, text: string, opts: TextTextureOptions): void;
export declare function createTextTexture(text: string, opts: TextTextureOptions): THREE.CanvasTexture;
export interface ClockDriver {
    /** 文本变化时重绘 canvas 并返回 true（调用方据此置 texture.needsUpdate）。 */
    update(now: Date): boolean;
}
export declare function createScriptDriver(canvas: HTMLCanvasElement, opts: TextTextureOptions, binding: TextScriptBinding, initialText?: string): ClockDriver;
export declare function createClockDriver(canvas: HTMLCanvasElement, opts: TextTextureOptions, props: Record<string, unknown>, initialText: string): ClockDriver;
