// src/client/settings-section.tsx —— DSH 设置对话框 "壁纸" section。
// 通过 ctx.slots.register('settings.section', ...) 挂载（见 client/index.ts），
// 提供：壁纸网格切换 / 取消壁纸 / 壁纸目录与引擎目录配置（手动输入 + 自动探测）。
// 数据与动作经 props 注入（默认走真实 API），便于 jsdom 单测。

import { useCallback, useEffect, useState } from 'react';
import type { ClientSettings } from './types.js';
import type { WallpaperInfo, ProbeResult } from '../shared/types.js';
import { readClientSettings, writeClientSettings } from './settings.js';
import { TEXT_OUTLINE_MAX, normalizeHexColor, normalizeMode, normalizeOutlineLevel, outlineLabel } from './text-color.js';
import { formatHealthLine } from './render-health.js';
import type { HealthSnapshot } from './render-health.js';

export interface WallpaperSettingsSectionProps {
  /** 读取当前设置（默认 RPC settings.describe） */
  fetchSettings?: () => Promise<ClientSettings>;
  /** 持久化设置（默认 RPC settings.update）；返回 false = 未写入（服务端拒绝/无可用命名空间） */
  writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>;
  /** 拉取壁纸列表（默认 GET /wallpapers/list） */
  fetchWallpapers?: () => Promise<WallpaperInfo[]>;
  /** 自动探测候选路径（默认 GET /wallpapers/probe） */
  fetchProbe?: () => Promise<ProbeResult>;
  /** 切换/取消壁纸（index.ts 注入 controller.select，空 id = 取消） */
  onSelect?: (id: string) => void;
  /** 运行期设置（光晕参数/暂停/画质档位）变更：index.ts 注入后立即下发给渲染器，无需重选壁纸 */
  onRuntimeSettings?: (patch: Partial<ClientSettings>) => void;
  /** 当前壁纸的渲染健康快照（由 index.ts 经 subscribeWallpaperHealth 推送；null = 还没选壁纸） */
  health?: HealthSnapshot | null;
  /** 重试实时渲染（默认走共享 handler 的 retry） */
  onRetryLive?: () => void;
  /** 清空失败记忆（默认走共享 handler 的 clearFailures） */
  onClearRenderFailures?: () => void;
}

async function defaultFetchWallpapers(): Promise<WallpaperInfo[]> {
  return (await fetch('/wallpapers/list')).json();
}

async function defaultFetchProbe(): Promise<ProbeResult> {
  return (await fetch('/wallpapers/probe')).json();
}

// 模块级共享选择处理器：index.ts bootstrap 时注册（委托 controller.select），
// 使 slot 渲染的组件（无法直接传 props）也能切换/取消壁纸。props.onSelect 优先。
let sharedOnSelect: ((id: string) => void) | null = null;

export function setWallpaperSelectHandler(fn: (id: string) => void): void {
  sharedOnSelect = fn;
}

// 运行期设置（省电/画质档位）的共享处理器：同样由 index.ts 注册（槽位组件无法直接传 props）。
let sharedOnRuntimeSettings: ((patch: Partial<ClientSettings>) => void) | null = null;

export function setWallpaperRuntimeHandler(fn: (patch: Partial<ClientSettings>) => void): void {
  sharedOnRuntimeSettings = fn;
}

/** 面板「实时渲染」卡片要的三件事：读状态、重试当前壁纸、清空全部失败记忆。 */
export interface WallpaperHealthHandler {
  get(): HealthSnapshot | null;
  retry(): void;
  clearFailures(): void;
}
let healthHandler: WallpaperHealthHandler | null = null;
const healthSubscribers = new Set<(s: HealthSnapshot | null) => void>();

/** 注册/撤销共享 handler（传 null = 撤销：面板回退到「读不到状态」的初始态）。 */
export function setWallpaperHealthHandler(handler: WallpaperHealthHandler | null): void {
  healthHandler = handler;
}

/** 订阅健康变化（组件挂载时订阅、卸载时退订；index.ts 调 notifyWallpaperHealth 推送）。 */
export function subscribeWallpaperHealth(cb: (s: HealthSnapshot | null) => void): () => void {
  healthSubscribers.add(cb);
  return () => { healthSubscribers.delete(cb); };
}

/** 由 index.ts 的健康事件调用；也用于组件挂载时补一次当前值。 */
export function notifyWallpaperHealth(snap: HealthSnapshot | null): void {
  for (const cb of Array.from(healthSubscribers)) {
    try { cb(snap); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
  }
}

// 本文件文案是中文硬编码（无 i18n 层）：formatHealthLine 要求传入翻译函数，这里透传。
const weT = (s: string): string => s;
// 还没选壁纸 / 还没推送过：状态行按「尚未渲染」呈现，不给 formatHealthLine 造一个假壁纸 id。
const EMPTY_HEALTH: HealthSnapshot = { wallpaperId: '', ok: null, failure: null, timing: null };

export function WallpaperSettingsSection(props: WallpaperSettingsSectionProps): JSX.Element {
  const fetchSettings = props.fetchSettings ?? readClientSettings;
  const writeSettings = props.writeSettings ?? writeClientSettings;
  const fetchWallpapers = props.fetchWallpapers ?? defaultFetchWallpapers;
  const fetchProbe = props.fetchProbe ?? defaultFetchProbe;
  const onSelect = props.onSelect ?? sharedOnSelect ?? (() => {});
  const onRuntimeSettings = props.onRuntimeSettings ?? sharedOnRuntimeSettings ?? (() => {});

  const [settings, setSettings] = useState<ClientSettings | null>(null);
  const [wallpapers, setWallpapers] = useState<WallpaperInfo[]>([]);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [wallpaperDir, setWallpaperDir] = useState('');
  const [weAssetsDir, setWeAssetsDir] = useState('');
  const [message, setMessage] = useState('');
  const [health, setHealth] = useState<HealthSnapshot | null>(props.health ?? null);

  // 挂载时先取一次当前值（打开面板即显示状态），再订阅后续推送；卸载时退订。
  useEffect(() => {
    setHealth(props.health ?? healthHandler?.get() ?? null);
    return subscribeWallpaperHealth((s) => setHealth(s));
  }, [props.health]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [s, list] = await Promise.all([
        fetchSettings(),
        fetchWallpapers().catch(() => [] as WallpaperInfo[]),
      ]);
      if (!alive) return;
      setSettings(s);
      setWallpapers(list);
      setWallpaperDir(s.wallpaperDir || '');
      setWeAssetsDir(s.weAssetsDir || '');
    })();
    return () => { alive = false; };
  }, [fetchSettings, fetchWallpapers]);

  // 选择/取消壁纸：同步回调（controller 立即生效）+ 持久化
  const select = useCallback((id: string) => {
    onSelect(id);
    setSettings((prev) => (prev ? { ...prev, selectedWallpaperId: id } : prev));
    void writeSettings({ selectedWallpaperId: id }).then((ok) => setMessage(ok === false
      ? '保存失败：选择未持久化（详见控制台）'
      : (id ? '壁纸已切换' : '已取消壁纸')));
  }, [onSelect, writeSettings]);

  // 刷新壁纸列表：重新从壁纸目录拉取最新列表（壁纸目录变更后手动刷新用）
  const refreshWallpapers = useCallback(() => {
    setMessage('');
    void fetchWallpapers()
      .then((list) => {
        setWallpapers(list);
        setMessage('壁纸列表已刷新');
      })
      .catch(() => setMessage('刷新壁纸失败'));
  }, [fetchWallpapers]);

  // 省电 / 画质档位 / 光晕参数：本地即时生效（经共享 handler 下发渲染器）+ 持久化（不必重选壁纸）
  const applyRuntime = useCallback((patch: Partial<ClientSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
    onRuntimeSettings(patch);
    void writeSettings(patch);
  }, [onRuntimeSettings, writeSettings]);

  // 保存手动输入的路径（空值 = 清除用户配置，回退默认）
  const saveDirs = useCallback(() => {
    void writeSettings({ wallpaperDir: wallpaperDir.trim(), weAssetsDir: weAssetsDir.trim() })
      .then((ok) => setMessage(ok === false ? '保存失败：设置未写入（详见控制台）' : '路径已保存'));
  }, [wallpaperDir, weAssetsDir, writeSettings]);

  const runProbe = useCallback(() => {
    setMessage('');
    void fetchProbe()
      .then(setProbe)
      .catch(() => setMessage('自动探测失败'));
  }, [fetchProbe]);

  const adopt = useCallback((path: string, key: 'wallpaperDir' | 'weAssetsDir') => {
    void writeSettings({ [key]: path } as Partial<ClientSettings>)
      .then((ok) => {
        if (ok === false) { setMessage('保存失败：设置未写入（详见控制台）'); return; }
        if (key === 'wallpaperDir') setWallpaperDir(path);
        else setWeAssetsDir(path);
        setMessage('已采用探测路径');
      });
  }, [writeSettings]);

  const currentTitle = settings
    ? (wallpapers.find((w) => w.id === settings.selectedWallpaperId)?.title ?? '无（默认背景）')
    : '';

  // 实时渲染状态：ok（最近一次装配结果）与 failure（失败记忆）可并存 ⇒ 主行讲「现在怎么样」、
  // 次级行讲「曾经失败过什么」；只按其中一个渲染会自相矛盾（现在正常时只剩失败文案）。
  const live = health ?? EMPTY_HEALTH;
  const liveCurrent = live.ok === true
    ? formatHealthLine({ ...live, failure: null }, weT)
    : formatHealthLine(live, weT);
  const liveMemory = live.ok === true && live.failure
    ? formatHealthLine({ ...live, ok: null, timing: null }, weT)
    : '';
  const liveState = live.ok === true ? 'ok' : (live.failure ? 'failed' : 'idle');

  // 两个入口：props 优先（可嵌入/可测），否则走 index.ts 注册的共享 handler；
  // 都没有时不谎报「已重试/已清除」（插件尚未挂载时是这种情况）。
  const retryLive = () => {
    if (props.onRetryLive) props.onRetryLive();
    else if (healthHandler) healthHandler.retry();
    else return;
    setMessage('已重试实时渲染');
  };
  const forgetFailures = () => {
    if (props.onClearRenderFailures) props.onClearRenderFailures();
    else if (healthHandler) healthHandler.clearFailures();
    else return;
    setMessage('已清除失败记忆');
  };

  return (
    <div className="wss-root">
      {/* 当前壁纸：信息条 */}
      <section className="wss-section">
        <div className="wss-current">
          <div className="wss-current-info">
            <span className="wss-current-label">当前壁纸</span>
            <span className="wss-current-name" title={currentTitle}>{currentTitle}</span>
          </div>
          <div className="wss-current-actions">
            <button type="button" className="wss-refresh" onClick={refreshWallpapers}>刷新壁纸</button>
            <button type="button" className="wss-cancel" onClick={() => select('')}>取消壁纸</button>
          </div>
        </div>
      </section>

      {/* 壁纸库：16:9 缩略图卡片（类型 chip 在左下、选中加 ✓ 角标） */}
      <section className="wss-section">
        <header className="wss-section-head">
          <h4 className="wss-section-title">壁纸库</h4>
          <span className="wss-count">{wallpapers.length} 张</span>
        </header>
        <div className="wss-grid">
          {wallpapers.map((w) => {
            const selected = settings?.selectedWallpaperId === w.id;
            return (
              <button
                key={w.id}
                type="button"
                className={'wss-thumb' + (selected ? ' wss-selected' : '')}
                data-id={w.id}
                title={w.title}
                aria-pressed={selected}
                onClick={() => select(w.id)}
              >
                <span className="wss-thumb-media">
                  {w.previewUrl
                    ? <img src={w.previewUrl} alt={w.title} loading="lazy" />
                    : <span className="wss-no-preview">无预览</span>}
                  <span className="wss-badge">{w.type.toUpperCase()}</span>
                  {selected && <span className="wss-check" aria-hidden="true">✓</span>}
                </span>
                <span className="wss-thumb-title">{w.title}</span>
              </button>
            );
          })}
        </div>
        {wallpapers.length === 0 && (
          <p className="wss-empty">还没有壁纸。请在下方设置壁纸目录，或点「自动探测」。</p>
        )}
      </section>
      {/* 显示效果：应用级 Glow（开关 + 阈值/强度，改完立即生效、不必重选壁纸） */}
      {settings && (
        <section className="wss-section">
          <h4 className="wss-section-title">显示效果</h4>
          <div className="wss-glow">
            <label className="wss-glow-row">
              <input
                type="checkbox"
                checked={settings.glowEnabled}
                onChange={(e) => applyRuntime({ glowEnabled: e.target.checked })}
              />
              光晕（立即生效）
            </label>
            {/* 阈值：bright-pass 的亮度门槛（0–0.99）；强度：辉光回叠倍率（0–4） */}
            <label className="wss-slider">
              <span className="wss-slider-head">
                <span>阈值</span>
                <span className="wss-value">{settings.glowThreshold.toFixed(2)}</span>
              </span>
              <input
                type="range"
                className="wss-glow-threshold"
                min={0}
                max={0.99}
                step={0.01}
                value={settings.glowThreshold}
                onChange={(e) => applyRuntime({ glowThreshold: Number(e.target.value) })}
              />
            </label>
            <label className="wss-slider">
              <span className="wss-slider-head">
                <span>强度</span>
                <span className="wss-value">{settings.glowStrength.toFixed(2)}</span>
              </span>
              <input
                type="range"
                className="wss-glow-strength"
                min={0}
                max={4}
                step={0.05}
                value={settings.glowStrength}
                onChange={(e) => applyRuntime({ glowStrength: Number(e.target.value) })}
              />
            </label>
          </div>
        </section>
      )}
      {/* 实时渲染：状态行 + 重试/清除入口（scene 壁纸渲染不出来时用户唯一的自救入口） */}
      <section className="wss-section">
        <h4 className="wss-section-title">实时渲染</h4>
        <div className="wss-live-status" data-state={liveState}>
          <p className="wss-section-desc wss-live-current">{liveCurrent}</p>
          {liveMemory && <p className="wss-section-desc wss-live-memory">{liveMemory}</p>}
        </div>
        <div className="wss-row">
          <button type="button" className="wss-live-retry" onClick={retryLive}>重试实时渲染</button>
          <button type="button" className="wss-live-forget" onClick={forgetFailures}>清除失败记忆</button>
        </div>
      </section>
      {/* 性能与省电：同一张卡片；wss-power 仍只含两个复选框（画质档位是 select） */}
      {settings && (
        <section className="wss-section">
          <h4 className="wss-section-title">性能与省电</h4>
          <div className="wss-power">
            <label className="wss-glow-row">
              <input
                type="checkbox"
                checked={settings.paused}
                onChange={(e) => applyRuntime({ paused: e.target.checked })}
              />
              暂停壁纸（省电）
            </label>
            <label className="wss-glow-row">
              <input
                type="checkbox"
                checked={settings.pauseOnHidden}
                onChange={(e) => applyRuntime({ pauseOnHidden: e.target.checked })}
              />
              切到后台时自动暂停
            </label>
            <label className="wss-row">
              <span>画质档位</span>
              <select
                className="wss-quality"
                value={String(settings.qualityScale)}
                onChange={(e) => applyRuntime({ qualityScale: Number(e.target.value) })}
              >
                <option value="1">原生（1×）</option>
                <option value="0.75">省显存（0.75×）</option>
                <option value="0.5">最省（0.5×）</option>
              </select>
            </label>
          </div>
          {/* 壁纸音效：默认开启（对齐桌面 WE）；关掉即停声，频谱类效果随之静止 */}
          <div className="wss-sound-row">
            <label className="wss-glow-row">
              <input
                type="checkbox"
                className="wss-sound"
                checked={settings.soundEnabled}
                onChange={(e) => applyRuntime({ soundEnabled: e.target.checked })}
              />
              壁纸音效
            </label>
          </div>
        </section>
      )}
      {/* 文字可读性（2026-10-01，用户报告「某些壁纸文字看不清」）：贴壁纸的文字可手动指定颜色
          （自动跟随壁纸亮度 / 白 / 黑 / 自定义），并可选描边（对立色阴影，背景花哨时最有效）。
          改动经 applyRuntime → onRuntimeSettings 立即下发（index.ts 转 controller.applyTextStyle），
          不必重选壁纸；被描边作用的只有贴壁纸的透明文字，实底气泡/卡片不受影响。 */}
      {settings && (
        <section className="wss-section">
          <h4 className="wss-section-title">文字可读性</h4>
          <p className="wss-section-desc">贴壁纸的文字（消息正文、标题、链接、聊天栏）看不清时，可固定文字颜色；背景花哨时开一点描边最有效。</p>
          <div className="wss-textcolor">
            <label className="wss-row">
              <span>文字颜色</span>
              <select
                className="wss-textcolor-mode"
                value={normalizeMode(settings.textColorMode)}
                onChange={(e) => applyRuntime({ textColorMode: e.target.value })}
              >
                <option value="auto">自动（跟随壁纸亮度）</option>
                <option value="white">白色</option>
                <option value="black">黑色</option>
                <option value="custom">自定义…</option>
              </select>
            </label>
            {normalizeMode(settings.textColorMode) === 'custom' && (
              <label className="wss-row">
                <span>自定义颜色</span>
                <input
                  type="color"
                  className="wss-textcolor-custom"
                  value={normalizeHexColor(settings.textColor)}
                  onChange={(e) => applyRuntime({ textColor: e.target.value })}
                />
              </label>
            )}
            <label className="wss-slider">
              <span className="wss-slider-head">
                <span>文字描边</span>
                <span className="wss-value">{outlineLabel(settings.textOutline)}</span>
              </span>
              <input
                type="range"
                className="wss-textcolor-outline"
                min={0}
                max={TEXT_OUTLINE_MAX}
                step={1}
                value={normalizeOutlineLevel(settings.textOutline)}
                onChange={(e) => applyRuntime({ textOutline: Number(e.target.value) })}
              />
            </label>
          </div>
        </section>
      )}
      <section className="wss-section">
        <h4 className="wss-section-title">壁纸目录</h4>
        <p className="wss-section-desc">填 Wallpaper Engine 的两个目录；留空 = 未配置。也可以直接点「自动探测」采用探测结果。</p>
        <label className="wss-field">
          <span className="wss-field-label">壁纸目录（workshop）</span>
          <input
            className="wss-dir-workshop"
            value={wallpaperDir}
            placeholder="例如 D:/Steam/steamapps/workshop/content/431960"
            onChange={(e) => setWallpaperDir(e.target.value)}
          />
        </label>
        <label className="wss-field">
          <span className="wss-field-label">引擎目录（particle 纹理）</span>
          <input
            className="wss-dir-assets"
            value={weAssetsDir}
            placeholder="例如 D:/Steam/steamapps/common/wallpaper_engine"
            onChange={(e) => setWeAssetsDir(e.target.value)}
          />
        </label>
        <div className="wss-dir-actions">
          <button type="button" className="wss-save-dirs" onClick={saveDirs}>保存路径</button>
          <button type="button" className="wss-probe" onClick={runProbe}>自动探测</button>
        </div>
        {probe && (
          <div className="wss-probe-result">
            <h5 className="wss-subtitle">探测到的壁纸目录</h5>
            {probe.workshop.map((c) => (
              <div key={c.path} className="wss-candidate" data-kind="workshop">
                <span className="wss-candidate-path" title={c.path}>{c.path}</span>
                <span className={c.exists ? 'wss-exists' : 'wss-missing'}>{c.exists ? '存在' : '不存在'}</span>
                <button type="button" className="wss-adopt" data-path={c.path} onClick={() => adopt(c.path, 'wallpaperDir')}>采用</button>
              </div>
            ))}
            <h5 className="wss-subtitle">探测到的引擎目录</h5>
            {probe.assets.map((c) => (
              <div key={c.path} className="wss-candidate" data-kind="assets">
                <span className="wss-candidate-path" title={c.path}>{c.path}</span>
                <span className={c.exists ? 'wss-exists' : 'wss-missing'}>{c.exists ? '存在' : '不存在'}</span>
                <button type="button" className="wss-adopt" data-path={c.path} onClick={() => adopt(c.path, 'weAssetsDir')}>采用</button>
              </div>
            ))}
          </div>
        )}
      </section>
      {message && <p className="wss-message" role="status">{message}</p>}
    </div>
  );
}
