export declare function findEmbeddedMp4(entry: Uint8Array): {
    offset: number;
} | null;
/** pkg 内是否有可播放的内嵌 MP4（视频纹理）。 */
export declare function probeEmbeddedMp4(pkgPath: string): boolean;
/** 取内嵌 MP4 原始字节（从 mp4 首个 box 起）；无则 null。 */
export declare function extractEmbeddedMp4(pkgPath: string): {
    entryName: string;
    bytes: Uint8Array;
} | null;
