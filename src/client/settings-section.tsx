// src/client/settings-section.tsx —— DSH 设置对话框 "壁纸" section。
// 通过 ctx.slots.register('settings.section', ...) 挂载（见 client/index.ts），
// 提供：壁纸网格切换 / 取消壁纸 / 壁纸目录与引擎目录配置（手动输入 + 自动探测）。
// 数据与动作经 props 注入（默认走真实 API），便于 jsdom 单测。

import { useCallback, useEffect, useState } from 'react';
import type { ClientSettings } from './types.js';
import type { WallpaperInfo, ProbeResult } from '../shared/types.js';
import { readClientSettings, writeClientSettings } from './settings.js';

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

  return (
    <div className="wss-root">
      <p className="wss-hint">选择壁纸背景，或取消以恢复默认背景。壁纸目录支持自动探测或手动填写。</p>
      <div className="wss-current">
        <span>当前壁纸：{currentTitle}</span>
        <div className="wss-current-actions">
          <button type="button" className="wss-refresh" onClick={refreshWallpapers}>刷新壁纸</button>
          <button type="button" className="wss-cancel" onClick={() => select('')}>取消壁纸</button>
        </div>
      </div>
      <div className="wss-grid">
        {wallpapers.map((w) => (
          <button
            key={w.id}
            type="button"
            className={'wss-thumb' + (settings?.selectedWallpaperId === w.id ? ' wss-selected' : '')}
            data-id={w.id}
            onClick={() => select(w.id)}
          >
            {w.previewUrl ? <img src={w.previewUrl} alt={w.title} loading="lazy" /> : <span className="wss-no-preview">无预览</span>}
            <span className="wss-badge">{w.type.toUpperCase()}</span>
            <span className="wss-thumb-title">{w.title}</span>
          </button>
        ))}
      </div>
      {/* 应用级 Glow：开关 + 阈值/强度，改完**立即生效**（经运行期通道下发，不必重选壁纸） */}
      {settings && (
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
          <label className="wss-glow-slider">
            <span>光晕阈值 {settings.glowThreshold.toFixed(2)}</span>
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
          <label className="wss-glow-slider">
            <span>光晕强度 {settings.glowStrength.toFixed(2)}</span>
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
      )}
      {/* 省电 / 画质档位：立即生效（不必重选壁纸） */}
      {settings && (
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
          <label className="wss-glow-row">
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
      )}
      {/* 壁纸音效：默认开启（对齐桌面 WE）；关掉即停声，频谱类效果随之静止。
          独立区块，不并入 wss-power（那里的复选框语义是省电 / 画质档位）。 */}
      {settings && (
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
      )}
      <div className="wss-dirs">
        <h4>壁纸目录</h4>
        <label className="wss-dir-row">
          <span>壁纸目录（workshop）</span>
          <input
            className="wss-dir-workshop"
            value={wallpaperDir}
            placeholder="例如 D:/Steam/steamapps/workshop/content/431960（留空 = 未配置）"
            onChange={(e) => setWallpaperDir(e.target.value)}
          />
        </label>
        <label className="wss-dir-row">
          <span>引擎目录（particle 纹理）</span>
          <input
            className="wss-dir-assets"
            value={weAssetsDir}
            placeholder="例如 D:/Steam/steamapps/common/wallpaper_engine（留空 = 未配置）"
            onChange={(e) => setWeAssetsDir(e.target.value)}
          />
        </label>
        <div className="wss-dir-actions">
          <button type="button" className="wss-save-dirs" onClick={saveDirs}>保存路径</button>
          <button type="button" className="wss-probe" onClick={runProbe}>自动探测</button>
        </div>
        {probe && (
          <div className="wss-probe-result">
            <h4>探测到的壁纸目录</h4>
            {probe.workshop.map((c) => (
              <div key={c.path} className="wss-candidate" data-kind="workshop">
                <span className="wss-candidate-path">{c.path}</span>
                <span className={c.exists ? 'wss-exists' : 'wss-missing'}>{c.exists ? '存在' : '不存在'}</span>
                <button type="button" className="wss-adopt" data-path={c.path} onClick={() => adopt(c.path, 'wallpaperDir')}>采用</button>
              </div>
            ))}
            <h4>探测到的引擎目录</h4>
            {probe.assets.map((c) => (
              <div key={c.path} className="wss-candidate" data-kind="assets">
                <span className="wss-candidate-path">{c.path}</span>
                <span className={c.exists ? 'wss-exists' : 'wss-missing'}>{c.exists ? '存在' : '不存在'}</span>
                <button type="button" className="wss-adopt" data-path={c.path} onClick={() => adopt(c.path, 'weAssetsDir')}>采用</button>
              </div>
            ))}
          </div>
        )}
      </div>
      {message && <p className="wss-message">{message}</p>}
    </div>
  );
}
