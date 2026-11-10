import * as THREE from 'three';
export type SpriteSheetLayer = {
    backgroundId: number;
    mesh: THREE.Mesh;
    frames: number;
    cols: number;
    rows: number;
    elapsed: number;
    fps: number;
    frame: number;
    paused: boolean;
    baseUv: Float32Array;
    uv: {
        u0: number;
        v0: number;
        u1: number;
        v1: number;
    };
};
export declare class SpriteSheetRuntime {
    private readonly layers;
    register(backgroundId: number, objectId: number, mesh: THREE.Mesh, sprite: {
        frames: number;
        cols: number;
        rows: number;
        frametime?: number;
    }): void;
    applyFrame(layer: SpriteSheetLayer, frame: number): void;
    update(dt: number): void;
    rebaseForBackground(backgroundId: number): void;
    pause(objectId: number): void;
    play(objectId: number): void;
    /** 停播并回到第 0 帧（对齐 AnimPlayback.stop 的语义）。 */
    stop(objectId: number): void;
    isPlaying(objectId: number): boolean;
    /** 立即写 UV（越界钳到 [0, frames-1]）；同时把 elapsed 对齐到该帧，play 后从这里继续。 */
    setFrame(objectId: number, frame: number): void;
    getFrame(objectId: number): number;
    /** 测试用：取精灵表图层当前帧的 UV 子矩形（仅测试/诊断观测，不参与渲染）。 */
    uvForTest(objectId: number): {
        u0: number;
        v0: number;
        u1: number;
        v1: number;
    } | null;
    clear(): void;
}
