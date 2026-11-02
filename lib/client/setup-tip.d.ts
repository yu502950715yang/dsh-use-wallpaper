import { type StorageLike } from './local-store.js';
import type { ClientSettings } from './types.js';
export interface SetupTipProps {
    /** 读取当前设置（默认走 RPC settings.describe） */
    fetchSettings?: () => Promise<ClientSettings>;
    /** 本地存储（默认 localStorage；测试注入） */
    storage?: StorageLike;
    /** 显示后自动消失的毫秒数；0 / 缺省 = 不自动消失 */
    autoHideMs?: number;
}
/**
 * 把提示条注册进 DSH 全框浮层（shell.overlay）：层级最高、默认 click-through，
 * 根元素自己接指针事件。宿主不提供 slots 时静默跳过（插件其余功能照常）。
 */
export declare function registerSetupTipSlots(ctx: any): boolean;
export declare function SetupTip(props?: SetupTipProps): JSX.Element | null;
