// DSH 设置面板「开机动画」页（Wallpaper 壁纸 tab 的内容）：设计系统统一样式，行为不变。
// 数据与动作经 props 注入（默认走真实 API / window.__wallpaperEngineBoot），便于 jsdom 单测。
import { useEffect, useState } from 'react';
import type { ClientSettings } from './types.js';
import type { WallpaperInfo } from '../shared/types.js';
import { readClientSettings, writeClientSettings } from './settings.js';

interface ProbeInfo { ok: boolean; exists?: boolean; isFile?: boolean; size?: number; playable?: boolean; error?: string }

export interface BootSettingsSectionProps {
  fetchSettings?: () => Promise<ClientSettings>;
  writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>;
  fetchWallpapers?: () => Promise<WallpaperInfo[]>;
  probePath?: (path: string) => Promise<ProbeInfo>;
  playPreview?: () => Promise<string>;
  getLast?: () => { result: string; at: number } | null;
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

  const source = settings.bootAnimationSource === 'local' ? 'local' : 'we';
  // 本地素材恒为视频；WE 素材按选择时的 kind 判断（视频不支持平铺）。
  const isVideoAsset = source === 'local' || settings.bootAnimationWallpaperKind === 'video';
  const picked = wallpapers.find((w) => w.id === settings.bootAnimationWallpaperId) ?? null;

  const runProbe = async () => {
    try {
      setProbe(await probePath(settings.bootAnimationLocalPath));
    } catch {
      setProbe({ ok: false, error: 'bad path' });
    }
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
            <span className="wbs-source-hint">绝对路径</span>
          </label>
        </div>

        <div className="wbs-picker" data-active={source === 'we'}>
          <div className="wbs-picker-preview" data-empty={!picked?.previewUrl}>
            {picked?.previewUrl
              ? <img src={picked.previewUrl} alt="" />
              : <span>{source === 'we' ? '未选择' : '—'}</span>}
          </div>
          <div className="wbs-picker-body">
            <select className="wbs-wallpaper" aria-label="开机动画素材" value={settings.bootAnimationWallpaperId}
              onChange={(e) => {
                const id = e.target.value;
                const item = wallpapers.find((w) => w.id === id);
                void patch({
                  bootAnimationWallpaperId: id,
                  bootAnimationWallpaperKind: item ? (item.type === 'image' ? 'image' : 'video') : '',
                });
              }}>
              <option value="">（未选择）</option>
              {wallpapers.map((w) => <option key={w.id} value={w.id}>{w.title} · {w.type === 'image' ? '图片' : '视频'}</option>)}
            </select>
            {wallpapers.length === 0 && <p className="wbs-desc">壁纸列表为空：请先在「日常壁纸」页配置目录或点刷新。</p>}
          </div>
        </div>

        <div className="wbs-local" data-active={source === 'local'}>
          <div className="wbs-row wbs-local-row">
            <input type="text" className="wbs-local-path" aria-label="本地视频路径" placeholder="E:\\clips\\boot.mp4"
              value={settings.bootAnimationLocalPath}
              onChange={(e) => setSettings((prev) => (prev ? { ...prev, bootAnimationLocalPath: e.target.value } : prev))}
              onBlur={(e) => void patch({ bootAnimationLocalPath: e.target.value })} />
            <button type="button" className="wbs-probe" onClick={() => void runProbe()}>校验</button>
          </div>
          {probe && <p className="wbs-probe-result" data-tone={probe.ok ? 'ok' : 'danger'}>{probeText(probe)}</p>}
        </div>
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
