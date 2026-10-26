export declare const VISUALIZER_BAR_COUNT = 64;
export declare function detectScriptPattern(src: string): 'visualizer' | 'clock' | null;
export declare function parseScriptProperties(scriptProperties: unknown): Record<string, unknown>;
export declare function formatClockText(date: Date, props: Record<string, unknown>): string;
export type VisualizerFamily = 'simple' | 'pixel-bars';
export interface PixelBarLayout {
    count: number;
    barWidth: number;
    minBarHeight: number;
    scaleX: number;
    scaleY: number;
    barPath: string;
    downscaleMode: 'max' | 'average';
}
export declare function detectVisualizerFamily(src: string, props: Record<string, unknown>): VisualizerFamily | null;
export declare function computePixelBarLayout(props: Record<string, unknown>, objectScale: [number, number, number]): PixelBarLayout;
