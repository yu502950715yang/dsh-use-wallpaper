import type { PointerState } from './parallax.js';
export interface PointerTracker {
    install(): void;
    dispose(): void;
    target(): Readonly<PointerState>;
}
export declare function createPointerTracker(opts?: {
    target?: EventTarget;
    viewport?: () => {
        width: number;
        height: number;
    };
}): PointerTracker;
