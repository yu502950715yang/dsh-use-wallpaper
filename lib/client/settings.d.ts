import type { ClientSettings } from './types.js';
export declare const DEFAULTS: ClientSettings;
/** 注入 client ctx：bootstrap(ctx) 时调用；无 ctx（node 测试/SSR）时回退默认值。 */
export declare function setSettingsCtx(ctx: any): void;
export declare function readClientSettings(): Promise<ClientSettings>;
/** 写入成功返回 true；全部候选 ns 都失败返回 false（供面板提示，不再谎报已保存）。 */
export declare function writeClientSettings(patch: Partial<ClientSettings>): Promise<boolean>;
export declare function getUserPropertyValue(key: string): unknown;
