import { Buffer } from 'node:buffer';
export declare const DEFAULT_MAX_FRAME_BYTES: number;
export declare const DEFAULT_MAX_FRAME_FILES = 200;
export type SceneFrameWriteResult = {
    ok: true;
} | {
    ok: false;
    reason: 'bad-id' | 'too-large' | 'bad-png' | 'write-failed';
};
export interface SceneFrameStoreOptions {
    maxBytes?: number;
    maxFiles?: number;
}
export interface SceneFrameStore {
    read(id: string): Buffer | null;
    write(id: string, png: Uint8Array): SceneFrameWriteResult;
    remove(id: string): {
        ok: true;
    };
}
/** 抓帧 PNG 存储：原子写 + 单文件/总数限额，id 白名单防穿越。 */
export declare function createSceneFrameStore(framesDir: string, opts?: SceneFrameStoreOptions): SceneFrameStore;
