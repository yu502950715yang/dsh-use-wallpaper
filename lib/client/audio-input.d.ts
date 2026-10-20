export interface AudioAnalyzer {
    context: AudioContext;
    analyser: AnalyserNode;
    freqData: Uint8Array;
    update(): void;
}
export declare function createAudioAnalyzer(): AudioAnalyzer | null;
export declare function playWallpaperSound(url: string, analyzer: {
    context: AudioContext;
    analyser: AnalyserNode;
}, opts?: {
    volume?: number;
    loop?: boolean;
}): Promise<boolean>;
