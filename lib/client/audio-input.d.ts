export interface AudioAnalyzer {
    context: AudioContext;
    analyser: AnalyserNode;
    freqData: Uint8Array;
    update(): void;
}
export declare function createAudioAnalyzer(): AudioAnalyzer | null;
export interface PlaybackHandle {
    stop(): void;
}
export declare const LARGE_AUDIO_BYTES: number;
type SoundAnalyzer = {
    context: AudioContext;
    analyser: AnalyserNode;
};
export declare function playWallpaperSound(url: string, analyzer: SoundAnalyzer | null, opts?: {
    volume?: number;
    loop?: boolean;
}): Promise<PlaybackHandle | null>;
export {};
