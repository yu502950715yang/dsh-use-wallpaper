// DSH 设置面板「开机动画」页（Wallpaper 壁纸 tab 的内容）：设计系统统一样式，行为不变。
// 素材选择区重点解决「看不清当前选了哪个」：当前素材大卡片 + 可视化壁纸网格 + 系统文件选择器。
import { useEffect, useState } from 'react';
import type { ClientSettings } from './types.js';
import type { WallpaperInfo } from '../shared/types.js';
import { readClientSettings, writeClientSettings } from './settings.js';

// 桌面壳（dsh-app://）preload 注入：把 <input type=file> 的 File 换成绝对路径（Electron webUtils）。
declare global {
  interface Window {
    __DSH_HOST_PATHS__?: { pathFor(file: File): string };
  }
}

interface ProbeInfo { ok: boolean; exists?: boolean; isFile?: boolean; size?: number; playable?: boolean; error?: string }

export interface BootSettingsSectionProps {
  fetchSettings?: () => Promise<ClientSettings>;
  writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>;
  fetchWallpapers?: () => Promise<WallpaperInfo[]>;
  probePath?: (path: string) => Promise<ProbeInfo>;
  playPreview?: () => Promise<string>;
  getLast?: () => { result: string; at: number } | null;
  /** 系统文件选择器 → 绝对路径；null = 当前环境不支持（回退手填）。默认用桌面壳 hostPaths API。 */
  pickLocalFile?: (() => Promise<string | null>) | null;
}

async function defaultFetchWallpapers(): Promise<WallpaperInfo[]> {
  return (await fetch('/wallpapers/list')).json();
}

async function defaultProbePath(path: string): Promise<ProbeInfo> {
  const r = await fetch('/wallpapers/boot/probe?path=' + encodeURIComponent(path));
  return r.json();
}

function bootApi(): any {
  return (globalThis as any).__wallpaperEngineBoot;
}

async function defaultPlayPreview(): Promise<string> {
  return (await bootApi()?.play?.({ force: true })) ?? 'disabled';
}

// 桌面端：隐藏 <input type=file> 选文件，再用 __DSH_HOST_PATHS__.pathFor 换成绝对路径。
// 浏览器（dsh web）没有该 API，由组件回退到手填路径。
async function defaultPickLocalFile(): Promise<string | null> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  const hostPaths = window.__DSH_HOST_PATHS__;
  if (!hostPaths || typeof hostPaths.pathFor !== 'function') return null;
  return new Promise<string | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*,.mp4,.webm,.mov,.m4v,.ogv';
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const done = (path: string | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(path);
    };
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      let path: string | null = null;
      try {
        path = file ? hostPaths.pathFor(file) : null;
      } catch {
        path = null;
      }
      done(path && path.trim() ? path : null);
    }, { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    input.click();
  });
}

const FITS: Array<{ value: string; label: string }> = [
  { value: 'tile', label: '平铺' },
  { value: 'contain', label: '居中' },
  { value: 'stretch', label: '挤压' },
  { value: 'cover', label: '裁切填满' },
];

const RESULT_TEXT: Record<string, string> = {
  ended: '播放完成', skipped: '已跳过', timeout: '素材超时（已跳过）', failed: '播放失败（已跳过）',
  'already-played': '本次会话已播过', disabled: '未启用', 'no-asset': '未选择素材',
};

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

// 播放结果 → 语义色：正常结束/跳过为 ok，超时/失败为 danger，其余中性。
function toneOf(result: string): Tone {
  if (result === 'ended' || result === 'skipped') return 'ok';
  if (result === 'timeout' || result === 'failed') return 'danger';
  if (result === 'already-played') return 'warn';
  return 'neutral';
}

function formatSize(n?: number): string {
  if (typeof n !== 'number') return '-';
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}

// probe 的 error 是英文协议串（not found / bad path），面板只给中文结论。
function probeText(probe: ProbeInfo): string {
  if (probe.ok) return `文件存在 · ${formatSize(probe.size)} · ${probe.playable ? '可播放' : '扩展名不支持'}`;
  return probe.error === 'not found' ? '文件不存在或不是普通文件' : '路径无效或扩展名不支持';
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function BootSettingsSection(props: BootSettingsSectionProps): JSX.Element {
  const fetchSettings = props.fetchSettings ?? readClientSettings;
  const save = props.writeSettings ?? writeClientSettings;
  const fetchWallpapers = props.fetchWallpapers ?? defaultFetchWallpapers;
  const probePath = props.probePath ?? defaultProbePath;
  const playPreview = props.playPreview ?? defaultPlayPreview;
  const getLast = props.getLast ?? (() => bootApi()?.getLast?.() ?? null);

  const [settings, setSettings] = useState<ClientSettings | null>(null);
  const [wallpapers, setWallpapers] = useState<WallpaperInfo[]>([]);
  const [probe, setProbe] = useState<ProbeInfo | null>(null);
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<Tone>('neutral');
  const [last, setLast] = useState<{ result: string; at: number } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  // 壁纸选择网格（默认收起，点「更换/选择壁纸」展开）
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');

  // 只挂载时读一次：读设置失败不抛（面板给提示），壁纸列表失败按空列表处理。
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const [s, list] = await Promise.all([fetchSettings(), fetchWallpapers().catch(() => [] as WallpaperInfo[])]);
        if (!alive) return;
        setSettings(s);
        setWallpapers(list.filter((w) => w.type === 'video' || w.type === 'image'));
        setLast(getLast());
      } catch {
        if (alive) setMessage('读取设置失败，请重新打开设置面板');
      }
    })();
    return () => { alive = false; };
  }, []);

  if (!settings) return <div className="wbs-root wbs-loading">加载中…</div>;

  const source = settings.bootAnimationSource === 'local' ? 'local' : 'we';
  // 本地素材恒为视频；WE 素材按选择时的 kind 判断（视频不支持平铺）。
  const isVideoAsset = source === 'local' || settings.bootAnimationWallpaperKind === 'video';
  const picked = wallpapers.find((w) => w.id === settings.bootAnimationWallpaperId) ?? null;
  const localFile = settings.bootAnimationLocalPath;
  // 桌面端（桌面壳注入 hostPaths）用系统选择器；否则回退手填（web / 旧版桌面）。
  const nativePick = props.pickLocalFile === null
    ? false
    : props.pickLocalFile !== undefined
      ? true
      : typeof window !== 'undefined' && typeof window.__DSH_HOST_PATHS__?.pathFor === 'function';
  const pick = nativePick ? (props.pickLocalFile ?? defaultPickLocalFile) : null;

  const filtered = wallpapers.filter((w) => {
    const q = query.trim().toLowerCase();
    return q === '' || w.title.toLowerCase().includes(q);
  });

  // 字段改动先更新本地 UI，再持久化；写失败明确提示（不谎报已保存）。
  const patch = async (p: Partial<ClientSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...p } : prev));
    try {
      const ok = await save(p);
      if (ok === false) setMessage('保存失败：设置服务不可用');
    } catch {
      setMessage('保存失败：设置服务不可用');
    }
  };

  const runProbe = async (pathOverride?: string): Promise<void> => {
    try {
      setProbe(await probePath(pathOverride ?? localFile));
    } catch {
      setProbe({ ok: false, error: 'bad path' });
    }
  };

  const chooseLocalFile = async (): Promise<void> => {
    if (pick === null) return;
    let path: string | null = null;
    try {
      path = await pick();
    } catch {
      path = null;
    }
    const trimmed = (path ?? '').trim();
    if (!trimmed) return;
    await patch({ bootAnimationLocalPath: trimmed });
    await runProbe(trimmed); // 选完立即校验，用户不用再点一次
  };

  const chooseWallpaper = (w: WallpaperInfo): void => {
    void patch({
      bootAnimationWallpaperId: w.id,
      bootAnimationWallpaperKind: w.type === 'image' ? 'image' : 'video',
    });
    setPickerOpen(false);
  };

  const runPreview = async () => {
    setPreviewing(true);
    setMessage('播放中…');
    setMessageTone('neutral');
    let result = 'failed';
    try { result = await playPreview(); } catch { result = 'failed'; }
    setPreviewing(false);
    // 中文结论 + 原始结果码（用户反馈问题时便于定位具体失败分支）。
    setMessage('结果：' + (RESULT_TEXT[result] ?? '失败') + '（' + result + '）');
    setMessageTone(toneOf(result));
  };

  return (
    <div className="wbs-root">
      <section className="wbs-hero">
        <div className="wbs-hero-body">
          <h4 className="wbs-hero-title">开机动画</h4>
          <p className="wbs-hero-desc">打开 DSH 时全屏播一段片头，播完淡出进入界面；固定静音，每次启动/新窗口只播一次（刷新不重播）。</p>
          {last && (
            <p className="wbs-last" data-tone={toneOf(last.result)}>
              上次播放：{RESULT_TEXT[last.result] ?? last.result}
            </p>
          )}
        </div>
        <label className="wbs-switch">
          <input type="checkbox" className="wbs-enable" checked={settings.bootAnimationEnabled}
            onChange={(e) => void patch({ bootAnimationEnabled: e.target.checked })} />
          <span className="wbs-switch-track" aria-hidden="true" />
          <span className="wbs-switch-label">启用</span>
        </label>
      </section>

      <section className="wbs-card">
        <header className="wbs-card-head">
          <h4 className="wbs-title">素材</h4>
          <span className="wbs-hint">视频 / 图片</span>
        </header>
        <div className="wbs-source-group" role="radiogroup" aria-label="素材来源">
          <label className="wbs-source" data-active={source === 'we'}>
            <input type="radio" name="wbs-source" className="wbs-source-we" checked={source === 'we'}
              onChange={() => void patch({ bootAnimationSource: 'we' })} />
            <span className="wbs-source-label">Wallpaper Engine 库</span>
            <span className="wbs-source-hint">仅视频 / 图片类</span>
          </label>
          <label className="wbs-source" data-active={source === 'local'}>
            <input type="radio" name="wbs-source" className="wbs-source-local" checked={source === 'local'}
              onChange={() => void patch({ bootAnimationSource: 'local' })} />
            <span className="wbs-source-label">本地视频文件</span>
            <span className="wbs-source-hint">{nativePick ? '系统选择器' : '手填绝对路径'}</span>
          </label>
        </div>

        {source === 'we' ? (
          <div className="wbs-we">
            {/* 当前素材大卡片：缩略图 + 标题 + 类型，一眼看清现在选的是哪个 */}
            <div className="wbs-current" data-empty={!picked} data-kind={picked ? (picked.type === 'image' ? 'image' : 'video') : 'none'}>
              <div className="wbs-current-thumb">
                {picked?.previewUrl ? <img src={picked.previewUrl} alt="" /> : <span>无预览</span>}
              </div>
              <div className="wbs-current-info">
                <span className="wbs-current-label">当前素材</span>
                <span className="wbs-current-title">
                  {picked?.title ?? (settings.bootAnimationWallpaperId ? '已选壁纸（不在当前列表）' : '未选择素材')}
                </span>
                <span className="wbs-current-meta">
                  {picked
                    ? (picked.type === 'image' ? '图片壁纸' : '视频壁纸') + (picked.hasPreviewGif ? ' · 动图预览' : '')
                    : '从 WE 库选一张视频 / 图片壁纸'}
                </span>
              </div>
              <button type="button" className="wbs-choose" onClick={() => setPickerOpen((v) => !v)}>
                {pickerOpen ? '收起' : picked ? '更换' : '选择壁纸'}
              </button>
            </div>

            {pickerOpen && (
              <div className="wbs-picker">
                <input type="search" className="wbs-wallpaper-search" aria-label="搜索壁纸" placeholder="搜索壁纸标题…"
                  value={query} onChange={(e) => setQuery(e.target.value)} />
                <div className="wbs-wallpaper-grid" role="listbox" aria-label="可选壁纸（视频 / 图片）">
                  {filtered.map((w) => (
                    <button key={w.id} type="button" role="option" aria-selected={w.id === settings.bootAnimationWallpaperId}
                      className="wbs-wallpaper-card" data-id={w.id} data-selected={w.id === settings.bootAnimationWallpaperId}
                      onClick={() => chooseWallpaper(w)}>
                      <span className="wbs-wallpaper-thumb">
                        {w.previewUrl ? <img src={w.previewUrl} alt="" loading="lazy" /> : null}
                        <span className="wbs-wallpaper-kind">{w.type === 'image' ? '图片' : '视频'}</span>
                      </span>
                      <span className="wbs-wallpaper-title" title={w.title}>{w.title}</span>
                    </button>
                  ))}
                  {filtered.length === 0 && <p className="wbs-desc wbs-wallpaper-empty">没有匹配的壁纸。</p>}
                </div>
                {wallpapers.length === 0 && <p className="wbs-desc">壁纸列表为空：请先在「日常壁纸」页配置目录或点刷新。</p>}
              </div>
            )}
          </div>
        ) : (
          <div className="wbs-local" data-active="true">
            <div className="wbs-current" data-empty={!localFile}>
              <div className="wbs-current-thumb wbs-current-thumb-file" aria-hidden="true">▶</div>
              <div className="wbs-current-info">
                <span className="wbs-current-label">当前素材</span>
                <span className="wbs-current-title">{localFile ? fileNameOf(localFile) : '未选择视频文件'}</span>
                <span className="wbs-current-meta" title={localFile || undefined}>
                  {localFile || '支持 mp4 / webm / mov / m4v / ogv'}
                </span>
              </div>
              {nativePick && (
                <button type="button" className="wbs-choose wbs-pick-file" onClick={() => void chooseLocalFile()}>
                  选择文件…
                </button>
              )}
            </div>
            {!nativePick && (
              <div className="wbs-row wbs-local-row">
                <input type="text" className="wbs-local-path" aria-label="本地视频路径" placeholder="E:\\clips\\boot.mp4"
                  value={localFile}
                  onChange={(e) => setSettings((prev) => (prev ? { ...prev, bootAnimationLocalPath: e.target.value } : prev))}
                  onBlur={(e) => void patch({ bootAnimationLocalPath: e.target.value })} />
                <button type="button" className="wbs-probe" onClick={() => void runProbe()}>校验</button>
              </div>
            )}
            {nativePick && localFile && (
              <button type="button" className="wbs-probe wbs-probe-inline" onClick={() => void runProbe()}>重新校验</button>
            )}
            {probe && <p className="wbs-probe-result" data-tone={probe.ok ? 'ok' : 'danger'}>{probeText(probe)}</p>}
          </div>
        )}
      </section>

      <section className="wbs-card">
        <header className="wbs-card-head">
          <h4 className="wbs-title">展示方式</h4>
          <span className="wbs-hint">画面如何适配全屏</span>
        </header>
        <div className="wbs-fit-grid" role="radiogroup" aria-label="展示方式">
          {FITS.map((f) => {
            const disabled = f.value === 'tile' && isVideoAsset;
            return (
              <label key={f.value} className="wbs-fit-card" data-fit={f.value} data-disabled={disabled} data-active={settings.bootAnimationFitMode === f.value}>
                <input type="radio" name="wbs-fit" className={'wbs-fit-' + f.value} checked={settings.bootAnimationFitMode === f.value}
                  disabled={disabled}
                  onChange={() => void patch({ bootAnimationFitMode: f.value })} />
                <span className="wbs-fit-art" data-fit={f.value} aria-hidden="true" />
                <span className="wbs-fit-label">{f.label}</span>
                {disabled && <span className="wbs-fit-hint">视频不支持</span>}
              </label>
            );
          })}
        </div>
      </section>

      <section className="wbs-card">
        <header className="wbs-card-head">
          <h4 className="wbs-title">最长播放</h4>
          <span className="wbs-value">{settings.bootAnimationMaxDurationMs === 0 ? '播完 / 不限' : Math.round(settings.bootAnimationMaxDurationMs / 1000) + ' 秒'}</span>
        </header>
        <label className="wbs-slider">
          <input type="range" className="wbs-max-duration" aria-label="最长播放时间（秒）" min={0} max={30} step={1}
            value={Math.round(settings.bootAnimationMaxDurationMs / 1000)}
            onChange={(e) => void patch({ bootAnimationMaxDurationMs: Number(e.target.value) * 1000 })} />
          <p className="wbs-desc">0 = 视频播完为止；图片固定约 4 秒。素材 8 秒未就绪会自动跳过。</p>
        </label>
      </section>

      <div className="wbs-actions">
        <button type="button" className="wbs-preview" disabled={previewing} onClick={() => void runPreview()}>
          {previewing ? '播放中…' : '试播'}
        </button>
        {message && <p className="wbs-message" data-tone={messageTone}>{message}</p>}
      </div>
    </div>
  );
}
