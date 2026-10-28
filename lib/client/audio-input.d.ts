export interface AudioAnalyzer {
    context: AudioContext;
    analyser: AnalyserNode;
    freqData: Uint8Array;
    update(): void;
    /** 省电暂停：挂起/恢复整个音频图（解码路径的 source 随 context 时钟冻结）。 */
    setSuspended(suspended: boolean): void;
}
export declare function createAudioAnalyzer(): AudioAnalyzer | null;
export interface PlaybackHandle {
    stop(): void;
    /** 省电暂停（流式元素）：保留播放位置；解码路径靠 AudioAnalyzer.setSuspended 冻结。 */
    pause?(): void;
    resume?(): void;
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
