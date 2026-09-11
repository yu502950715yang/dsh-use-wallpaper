import type { ClientSettings } from './types.js';
export declare const DEFAULTS: ClientSettings;
/** 注入 client ctx：bootstrap(ctx) 时调用；无 ctx（node 测试/SSR）时回退默认值。 */
export declare function setSettingsCtx(ctx: any): void;
export declare function readClientSettings(): Promise<ClientSettings>;
export declare function writeClientSettings(patch: Partial<ClientSettings>): Promise<void>;
export declare function getUserPropertyValue(key: string): unknown;
