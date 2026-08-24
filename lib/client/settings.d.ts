import type { ClientSettings } from './types.js';
export declare const DEFAULTS: ClientSettings;
export declare function readClientSettings(): Promise<ClientSettings>;
export declare function writeClientSettings(patch: Partial<ClientSettings>): Promise<void>;
export declare function getUserPropertyValue(key: string): unknown;
