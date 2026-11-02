// 首次安装提示条（注册进 DSH shell.overlay 槽位）：未配置素材目录时提示一次设置入口，
// 用 localStorage 标记只提示一次；读设置失败 / 已配置都静默不显示。
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { readClientSettings } from './settings.js';
import { STORAGE_KEYS, type StorageLike } from './local-store.js';
import type { ClientSettings } from './types.js';

export interface SetupTipProps {
  /** 读取当前设置（默认走 RPC settings.describe） */
  fetchSettings?: () => Promise<ClientSettings>;
  /** 本地存储（默认 localStorage；测试注入） */
  storage?: StorageLike;
  /** 显示后自动消失的毫秒数；0 / 缺省 = 不自动消失 */
  autoHideMs?: number;
}

/** shell.overlay 是 list slot：用自定义 id 只追加条目，不替换官方 toast。 */
const SETUP_TIP_ID = 'wallpaper-engine-setup-tip';

/**
 * 把提示条注册进 DSH 全框浮层（shell.overlay）：层级最高、默认 click-through，
 * 根元素自己接指针事件。宿主不提供 slots 时静默跳过（插件其余功能照常）。
 */
export function registerSetupTipSlots(ctx: any): boolean {
  if (!ctx?.slots?.inject || !ctx?.slots?.register) return false;
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: SETUP_TIP_ID,
    order: 30,
  }, SetupTip));
  return true;
}

function storeOf(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

export function SetupTip(props: SetupTipProps = {}): JSX.Element | null {
  const fetchSettings = props.fetchSettings ?? readClientSettings;
  // 真实注册走默认 15s 自动淡出；测试传 0 禁用定时器。
  const autoHideMs = props.autoHideMs ?? 15000;
  const [visible, setVisible] = useState(false);
  // 判定完成前不渲染：避免「先闪一下再消失」。
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const store = storeOf(props.storage);
      if (store?.getItem(STORAGE_KEYS.setupTip)) {
        if (alive) setSettled(true); // 提示过：不再打扰
        return;
      }
      let configured = false;
      try {
        const s = await fetchSettings();
        configured = !!(s.wallpaperDir || s.weAssetsDir);
      } catch {
        if (alive) setSettled(true); // 读不到设置：静默（不猜）
        return;
      }
      if (!alive) return;
      if (!configured) {
        store?.setItem(STORAGE_KEYS.setupTip, '1'); // 一次性：显示即写标记
        setVisible(true);
      }
      setSettled(true);
    })();
    return () => { alive = false; };
  }, [fetchSettings, props.storage]);

  useEffect(() => {
    if (!visible || !autoHideMs) return;
    const timer = setTimeout(() => setVisible(false), autoHideMs);
    return () => clearTimeout(timer);
  }, [visible, autoHideMs]);

  if (!settled || !visible || typeof document === 'undefined') return null;
  // portal 到 body：避开 shell.overlay 的层叠上下文（z-index:20），也保证不被设置对话框遮住；
  // 与官方 Toast 同级的 1100。样式在 styles.ts（.wst-*，只用 DSH token）。
  return createPortal(
    <div className="wst-root" role="status" aria-live="polite">
      <div className="wst-body">
        <p className="wst-title">壁纸引擎还差一步</p>
        <p className="wst-desc">
          打开 <b>设置 → Wallpaper 壁纸</b>，点「自动探测」找到 Wallpaper Engine 的素材目录，就能选壁纸了。
        </p>
      </div>
      <button type="button" className="wst-dismiss" onClick={() => setVisible(false)}>知道了</button>
    </div>,
    document.body,
  );
}
