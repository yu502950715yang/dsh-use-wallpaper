export declare const VISUALIZER_BAR_COUNT = 64;
export declare function detectScriptPattern(src: string): 'visualizer' | 'clock' | null;
export declare function parseScriptProperties(scriptProperties: unknown): Record<string, unknown>;
export declare function formatClockText(date: Date, props: Record<string, unknown>): string;
