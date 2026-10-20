import { type GlowStage } from './glow-stage.js';
export interface BloomOptions {
    strength?: number;
    threshold?: number;
}
/** 创建壁纸级 bloom stage；非法视口返回 null（与 createGlowStage 同一契约）。 */
export declare function createBloomStage(width: number, height: number, opts?: BloomOptions): GlowStage | null;
