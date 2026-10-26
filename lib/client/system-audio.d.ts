export type SystemAudioFailure = 'unsupported' | 'denied' | 'no-audio-track' | 'no-web-audio' | 'error';
export interface SystemAudioCapture {
    context: AudioContext;
    analyser: AnalyserNode;
    freqData: Uint8Array;
    stream: MediaStream;
    update(): void;
    stop(): void;
}
export declare function startSystemAudioCapture(onEnded?: () => void): Promise<SystemAudioCapture | SystemAudioFailure>;
