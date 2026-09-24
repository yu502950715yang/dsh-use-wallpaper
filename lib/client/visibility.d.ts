import type { VisibleBinding } from '../shared/types.js';
export declare function parseVisible(raw: unknown): VisibleBinding | undefined;
export declare function isStaticallyHidden(binding: VisibleBinding | undefined, userProps: Record<string, unknown>): boolean;
export declare function resolveVisibility(obj: {
    visible?: VisibleBinding | undefined;
}, userProps: Record<string, unknown>): boolean;
