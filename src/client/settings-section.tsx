// src/client/settings-section.tsx —— DSH 设置对话框 "壁纸" section。
// 通过 ctx.slots.register('settings.section', ...) 挂载（见 client/index.ts），
// 提供：壁纸网格切换 / 取消壁纸 / 壁纸目录与引擎目录配置（手动输入 + 自动探测）。
// 数据与动作经 props 注入（默认走真实 API），便于 jsdom 单测。

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientSettings, FitMode, RotationOrder } from './types.js';
import type {
  WallpaperInfo, WallpaperKind, ProbeResult, WallpaperUserProperty, UserPropertyValue,
} from '../shared/types.js';
import { readClientSettings, writeClientSettings } from './settings.js';
import {
  fetchWallpaperProperties, readUserProperty, resetUserProperty, writeUserProperty,
  type WallpaperPropertiesResponse,
} from './wallpaper-properties.js';
import type { SystemAudioFailure } from './system-audio.js';
import { parseColorTriplet, propertyConditionMet } from './user-bindings.js';
import { TEXT_OUTLINE_MAX, normalizeHexColor, normalizeMode, normalizeOutlineLevel, outlineLabel } from './text-color.js';
import { formatHealthLine } from './render-health.js';
import type { HealthSnapshot } from './render-health.js';
import type { MediaFailure, MediaFailureKind, MediaFallback } from './media-health.js';
import { filterLibrary, loadLibraryState, toggleFavorite, toggleHidden } from './library-view.js';
import type { LibraryFilter, LibraryState } from './library-view.js';
import { ROTATION_INTERVAL_OPTIONS, buildRotationPool, formatRotationInterval, normalizeRotationOrder } from './rotation.js';

export interface WallpaperSettingsSectionProps {
  /** 读取当前设置（默认 RPC settings.describe） */
  fetchSettings?: () => Promise<ClientSettings>;
  /** 持久化设置（默认 RPC settings.update）；返回 false = 未写入（服务端拒绝/无可用命名空间） */
  writeSettings?: (patch: Partial<ClientSettings>) => Promise<boolean | void>;
  /** 拉取壁纸列表（默认 GET /wallpapers/list） */
  fetchWallpapers?: () => Promise<WallpaperInfo[]>;
  /** 自动探测候选路径（默认 GET /wallpapers/probe） */
  fetchProbe?: () => Promise<ProbeResult>;
  /** 拉取当前 scene 壁纸的用户属性（默认 GET /wallpapers/properties） */
  fetchProperties?: (id: string) => Promise<WallpaperPropertiesResponse>;
  /** 切换/取消壁纸（index.ts 注入 controller.select，空 id = 取消） */
  onSelect?: (id: string) => void;
  /** 用户属性切换后重装配当前壁纸（默认走共享 handler 的 controller.select） */
  onReselect?: (id: string) => void;
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

export function setWallpaperSelectHandler(fn: ((id: string) => void) | null): void {
  sharedOnSelect = fn;
}

// 运行期设置（省电/画质档位）的共享处理器：同样由 index.ts 注册（槽位组件无法直接传 props）。
let sharedOnRuntimeSettings: ((patch: Partial<ClientSettings>) => void) | null = null;

export function setWallpaperRuntimeHandler(fn: ((patch: Partial<ClientSettings>) => void) | null): void {
  sharedOnRuntimeSettings = fn;
}

// 用户属性切换后的重装配处理器：属性值存在 localStorage，渲染器只在装配时读取，
// 故切换后需重新 select 当前壁纸（不弹提示、不写设置）。传 null = 撤销（teardown）。
let sharedOnReselect: ((id: string) => void) | null = null;

export function setWallpaperReselectHandler(handler: ((id: string) => void) | null): void {
  sharedOnReselect = handler;
}

// 系统音频（v0.9 P1）：浏览器模式经 getDisplayMedia 捕获系统音频驱动频谱；桌面 App 宿主禁用。
export interface SystemAudioHandlers {
  start(): Promise<SystemAudioFailure | 'ok'>;
  stop(): void;
}
let sharedSystemAudio: SystemAudioHandlers | null = null;

/** 注册/撤销系统音频处理器（index.ts 注入渲染器实现；null = 撤销）。 */
export function setWallpaperSystemAudioHandlers(handlers: SystemAudioHandlers | null): void {
  sharedSystemAudio = handlers;
}

// 失败原因文案（失败开放：不支持的宿主给明确指引，不假装成功）。
function systemAudioErrorMessage(failure: SystemAudioFailure): string {
  switch (failure) {
    case 'unsupported':
      return '当前环境不支持捕获系统音频（桌面版 App 禁用了该权限，请用浏览器打开本 GUI 地址再试）';
    case 'denied':
      return '未授权：请在弹窗中选择共享并勾选「共享音频」；拒绝后不会自动重试。';
    case 'no-audio-track':
      return '没有捕获到音频轨：请重新选择并勾选「共享音频」（只共享画面不会出声）。';
    case 'no-web-audio':
      return '当前浏览器缺少 Web Audio 支持，无法分析系统音频。';
    default:
      return '捕获系统音频失败（未知原因），已保持静音。';
  }
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

/** 面板「媒体失败提示」要的两件事：读当前失败 / 清除。 */
export interface WallpaperMediaHandler {
  get(): MediaFailure | null;
  clear(): void;
}
let mediaHandler: WallpaperMediaHandler | null = null;
const mediaSubscribers = new Set<(failure: MediaFailure | null) => void>();

/** 注册/撤销共享 handler（传 null = 面板回到「无失败」初始态，并清掉已显示的提示）。 */
export function setWallpaperMediaHandler(handler: WallpaperMediaHandler | null): void {
  mediaHandler = handler;
  pushMedia(handler?.get() ?? null);
}

/** 订阅媒体失败变化（组件挂载时订阅、卸载时退订）。 */
export function subscribeWallpaperMedia(cb: (failure: MediaFailure | null) => void): () => void {
  mediaSubscribers.add(cb);
  return () => { mediaSubscribers.delete(cb); };
}

/** 由 index.ts 的媒体失败事件调用；handler 未注册时不推（面板已回初始态，迟到的失败不得复活提示）。 */
export function notifyWallpaperMedia(failure: MediaFailure | null): void {
  if (!mediaHandler) return;
  pushMedia(failure);
}

function pushMedia(failure: MediaFailure | null): void {
  for (const cb of Array.from(mediaSubscribers)) {
    try { cb(failure); } catch { /* 单个订阅者异常不影响其它订阅者 */ }
  }
}

// 本文件文案是中文硬编码（无 i18n 层）：formatHealthLine 要求传入翻译函数，这里透传。
const weT = (s: string): string => s;
// 还没选壁纸 / 还没推送过：状态行按「尚未渲染」呈现，不给 formatHealthLine 造一个假壁纸 id。
const EMPTY_HEALTH: HealthSnapshot = { wallpaperId: '', ok: null, failure: null, timing: null };
// 按 kind × fallback 分档：只有真的显示了预览图才能说「已回退到预览图」；timeout 与 unsupported 仍需可区分。
const MEDIA_FAILURE_TEXT: Record<MediaFailureKind, Record<MediaFallback, string>> = {
  unsupported: {
    preview: '该视频壁纸解码失败（可能是 HEVC/H.265），已回退到预览图；建议改用 Chrome 或转换编码。',
    none: '该视频壁纸解码失败（可能是 HEVC/H.265），且没有可用的预览图；建议改用 Chrome 或转换编码。',
  },
  timeout: {
    preview: '视频壁纸加载超时：1.5 秒内没有出现首帧，已回退到预览图；建议改用 Chrome 或检查视频文件。',
    none: '视频壁纸加载超时：1.5 秒内没有出现首帧，且没有可用的预览图；建议改用 Chrome 或检查视频文件。',
  },
};

// ── 四类型用户属性控件的小工具（纯函数；类型/颜色/精度语义见 spec §6） ──
type SliderProperty = Extract<WallpaperUserProperty, { type: 'slider' }>;
const KNOWN_USERPROP_TYPES: ReadonlySet<string> = new Set(['bool', 'slider', 'color', 'combo']);

function isKnownUserProperty(property: WallpaperUserProperty): boolean {
  return KNOWN_USERPROP_TYPES.has(property.type);
}

/** 初值：localStorage 覆盖值（按类型校验）优先，否则壁纸默认值。 */
function initialPropertyValue(property: WallpaperUserProperty, wallpaperId: string): UserPropertyValue {
  const stored = readUserProperty(property.key, wallpaperId);
  switch (property.type) {
    case 'bool':
      return typeof stored === 'boolean' ? stored : property.value;
    case 'slider':
      return typeof stored === 'number' && Number.isFinite(stored)
        ? Math.min(property.max, Math.max(property.min, stored))
        : property.value;
    case 'color':
      return typeof stored === 'string' && parseColorTriplet(stored) ? stored : property.value;
    case 'combo':
      return typeof stored === 'string' && property.options.some((o) => o.value === stored)
        ? stored
        : property.value;
    default:
      return false; // text/未知类型不渲染，这里只为类型收窄
  }
}

function sliderStep(property: SliderProperty): number {
  return typeof property.step === 'number' && Number.isFinite(property.step) && property.step > 0
    ? property.step
    : (property.fraction === false ? 1 : 0.01);
}

function sliderDecimals(property: SliderProperty): number {
  if (typeof property.precision === 'number' && Number.isFinite(property.precision)) {
    return Math.min(10, Math.max(0, Math.floor(property.precision)));
  }
  const text = String(sliderStep(property));
  const exp = /e-(\d+)$/i.exec(text);
  if (exp) return Math.min(10, Number(exp[1]));
  const dot = text.indexOf('.');
  return dot >= 0 ? Math.min(10, text.length - dot - 1) : 0;
}

/** 显示值：fraction=false 取整；否则按 precision（缺省由 step 推导）补零。 */
function formatSliderValue(value: number, property: SliderProperty): string {
  return property.fraction === false ? String(Math.round(value)) : value.toFixed(sliderDecimals(property));
}

/** WE "r g b"（0-1）→ #rrggbb；非法值回退黑色。 */
function colorTripletToHex(value: string): string {
  const rgb = parseColorTriplet(value) ?? [0, 0, 0];
  return '#' + rgb
    .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0'))
    .join('');
}

/** #rrggbb → WE "r g b"（0-1，4 位小数足够 8-bit 往返）。 */
function hexToColorTriplet(hex: string): string {
  const normalized = normalizeHexColor(hex, '#000000');
  const full = normalized.length === 4
    ? `#${normalized[1]}${normalized[1]}${normalized[2]}${normalized[2]}${normalized[3]}${normalized[3]}`
    : normalized;
  const component = (index: number) => {
    const n = parseInt(full.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return String(Number(n.toFixed(4)));
  };
  return `${component(0)} ${component(1)} ${component(2)}`;
}

export function WallpaperSettingsSection(props: WallpaperSettingsSectionProps): JSX.Element {
  const fetchSettings = props.fetchSettings ?? readClientSettings;
  const writeSettings = props.writeSettings ?? writeClientSettings;
  const fetchWallpapers = props.fetchWallpapers ?? defaultFetchWallpapers;
  const fetchProbe = props.fetchProbe ?? defaultFetchProbe;
  const fetchProperties = props.fetchProperties ?? fetchWallpaperProperties;
  const onSelect = props.onSelect ?? sharedOnSelect ?? (() => {});
  const onReselect = props.onReselect ?? sharedOnReselect ?? (() => {});
  const onRuntimeSettings = props.onRuntimeSettings ?? sharedOnRuntimeSettings ?? (() => {});

  const [settings, setSettings] = useState<ClientSettings | null>(null);
  const [wallpapers, setWallpapers] = useState<WallpaperInfo[]>([]);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [wallpaperDir, setWallpaperDir] = useState('');
  const [weAssetsDir, setWeAssetsDir] = useState('');
  const [message, setMessage] = useState('');
  const [health, setHealth] = useState<HealthSnapshot | null>(props.health ?? null);
  // 媒体失败（视频解码）：handler 由 index.ts 注册，提示条在其卡片下方显示。
  const [mediaFailure, setMediaFailure] = useState<MediaFailure | null>(mediaHandler?.get() ?? null);
  // 壁纸库筛选状态：收藏/隐藏/最近使用来自 localStorage（挂载时读一次，操作后即时落盘）。
  const [libState, setLibState] = useState<LibraryState>(loadLibraryState);
  // 壁纸用户属性（v0.9 四类型）：只对当前选中的 scene 壁纸拉取一次。
  const [properties, setProperties] = useState<WallpaperUserProperty[]>([]);
  // 系统音频（v0.9 P1）：audioProcessing = project.json supportsaudioprocessing；采集状态由共享 handler 驱动。
  const [audioProcessing, setAudioProcessing] = useState(false);
  const [systemAudioState, setSystemAudioState] = useState<'idle' | 'starting' | 'active'>('idle');
  const [systemAudioError, setSystemAudioError] = useState<SystemAudioFailure | null>(null);
  const [propValues, setPropValues] = useState<Record<string, UserPropertyValue>>({});
  // 属性提交防抖（slider/color）：每键一个定时器 + 待提交值；切壁纸/卸载时清理（避免写回上一张）。
  const commitTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const commitPending = useRef(new Map<string, UserPropertyValue>());
  const [filter, setFilter] = useState<LibraryFilter>({
    query: '', types: [], favoritesOnly: false, showHidden: false, sort: 'default',
  });
  const visibleWallpapers = filterLibrary(wallpapers, filter, libState);
  const selectedId = settings?.selectedWallpaperId ?? '';
  const selectedIsScene = !!selectedId && wallpapers.some((w) => w.id === selectedId && (w.type === 'scene' || w.type === 'preset'));

  // 取消全部未提交的防抖（切壁纸/卸载/属性重拉时调用）。
  const clearCommitTimers = useCallback(() => {
    for (const timer of commitTimers.current.values()) clearTimeout(timer);
    commitTimers.current.clear();
    commitPending.current.clear();
  }, []);

  // 挂载时先取一次当前值（打开面板即显示状态），再订阅后续推送；卸载时退订。
  useEffect(() => {
    setHealth(props.health ?? healthHandler?.get() ?? null);
    return subscribeWallpaperHealth((s) => setHealth(s));
  }, [props.health]);

  useEffect(() => {
    setMediaFailure(mediaHandler?.get() ?? null);
    return subscribeWallpaperMedia((f) => setMediaFailure(f));
  }, []);

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

  // 切换壁纸时重新拉取属性；控件初值 = localStorage 覆盖值，否则壁纸默认 value。
  useEffect(() => {
    if (!selectedIsScene) {
      setProperties([]);
      setPropValues({});
      setAudioProcessing(false);
      setSystemAudioState('idle');
      setSystemAudioError(null);
      return;
    }
    let alive = true;
    void fetchProperties(selectedId)
      .then((res) => {
        if (!alive) return;
        const items = Array.isArray(res?.properties) ? res.properties : [];
        setAudioProcessing(res?.audioProcessing === true);
        setProperties(items);
        const values: Record<string, UserPropertyValue> = {};
        for (const p of items) {
          // text/未知类型不进面板；其余仍初始化（condition 可能引用未渲染的属性）。
          if (isKnownUserProperty(p)) values[p.key] = initialPropertyValue(p, selectedId);
        }
        setPropValues(values);
      })
      .catch(() => {
        if (!alive) return;
        setProperties([]);
        setPropValues({});
        setAudioProcessing(false);
      });
    return () => {
      alive = false;
      clearCommitTimers();
    };
  }, [selectedId, selectedIsScene, fetchProperties, clearCommitTimers]);

  // 卸载兜底：防抖定时器不得在组件消失后继续提交。
  useEffect(() => () => clearCommitTimers(), [clearCommitTimers]);

  // 系统音频（v0.9 P1）：启动需要用户手势 + 浏览器授权；失败原因回显到面板（不静默）。
  const startSystemAudio = useCallback(async () => {
    if (!sharedSystemAudio) {
      setSystemAudioError('unsupported');
      return;
    }
    setSystemAudioState('starting');
    setSystemAudioError(null);
    try {
      const result = await sharedSystemAudio.start();
      if (result === 'ok') setSystemAudioState('active');
      else {
        setSystemAudioState('idle');
        setSystemAudioError(result);
      }
    } catch {
      setSystemAudioState('idle');
      setSystemAudioError('error');
    }
  }, []);

  const stopSystemAudio = useCallback(() => {
    sharedSystemAudio?.stop();
    setSystemAudioState('idle');
  }, []);

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

  // 用户属性提交：写 per-wallpaper 覆盖值后重装配当前壁纸（渲染器装配时读取）。
  const setPropertyValue = useCallback((key: string, value: UserPropertyValue) => {
    setPropValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const commitProperty = useCallback((key: string, value: UserPropertyValue) => {
    writeUserProperty(key, value, selectedId);
    onReselect(selectedId);
  }, [onReselect, selectedId]);

  // 属性防抖：300ms 内无新输入才提交一次；pointerup/blur 走 flush 立即提交（slider/color）。
  const cancelCommit = useCallback((key: string) => {
    const timer = commitTimers.current.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      commitTimers.current.delete(key);
    }
    commitPending.current.delete(key);
  }, []);

  const flushCommit = useCallback((key: string) => {
    const pending = commitPending.current.get(key);
    cancelCommit(key);
    if (pending === undefined) return;
    commitProperty(key, pending);
  }, [cancelCommit, commitProperty]);

  const scheduleCommit = useCallback((key: string, value: UserPropertyValue) => {
    commitPending.current.set(key, value);
    const timer = commitTimers.current.get(key);
    if (timer !== undefined) clearTimeout(timer);
    commitTimers.current.set(key, setTimeout(() => {
      commitTimers.current.delete(key);
      flushCommit(key);
    }, 300));
  }, [flushCommit]);

  // 恢复默认：删 per-id 覆盖键（必须带 id）→ 控件回默认值 → 重装配。
  const resetProperty = useCallback((property: WallpaperUserProperty) => {
    cancelCommit(property.key); // 取消未提交的防抖，旧值不回写
    resetUserProperty(property.key, selectedId);
    setPropertyValue(property.key, property.value);
    onReselect(selectedId);
  }, [cancelCommit, onReselect, selectedId, setPropertyValue]);

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

  // 当前壁纸元信息（Hero）：预览/类型/状态直接从列表与健康快照推导，不额外请求。
  const currentWallpaper = settings
    ? wallpapers.find((w) => w.id === settings.selectedWallpaperId)
    : undefined;
  const heroStatus = !settings?.selectedWallpaperId
    ? { tone: 'idle', text: '未选择壁纸' }
    : liveState === 'ok'
      ? { tone: 'ok', text: '实时渲染中' }
      : liveState === 'failed'
        ? { tone: 'danger', text: '实时渲染失败' }
        : { tone: 'idle', text: '待渲染' };
  // 快捷导航只做滚动定位（jsdom 没有 scrollIntoView 时静默跳过）。
  const jumpTo = (id: string) => {
    const el = document.getElementById(id);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // 轮播状态行：可轮播池按当前列表 + 收藏/隐藏实时算（池 <2 张时明确提示原因，不静默）。
  const rotationPoolSize = buildRotationPool(wallpapers, libState).length;
  const rotationStatus = rotationPoolSize < 2
    ? '至少保留 2 张可轮播壁纸，或收藏 2 张以上'
    : `每 ${formatRotationInterval(settings?.rotationIntervalMs)} · ${normalizeRotationOrder(settings?.rotationOrder) === 'sequential' ? '顺序' : '随机'} · 可轮播 ${rotationPoolSize} 张`;

  // 只渲染 scene 真正引用（usedBy 非空）的已知类型属性；text 等不渲染。
  const visibleProperties = properties.filter(
    (p) => isKnownUserProperty(p) && Array.isArray(p.usedBy) && p.usedBy.length > 0,
  );

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
  const dismissMediaFailure = () => {
    mediaHandler?.clear();
    setMediaFailure(null); // 立即隐藏；真实 handler 也会经订阅推送 null
  };

  return (
    <div className="wss-root">
      {/* Hero：大预览 + 标题/类型/渲染状态 + 主操作，作为面板视觉锚点 */}
      <section className="wss-section wss-hero" aria-label="当前壁纸">
        <div className="wss-hero-media" data-empty={!currentWallpaper?.previewUrl}>
          {currentWallpaper?.previewUrl
            ? <img src={currentWallpaper.previewUrl} alt={currentTitle} />
            : <span className="wss-hero-empty">还没有选择壁纸</span>}
        </div>
        <div className="wss-hero-info">
          <div className="wss-current">
            <div className="wss-current-info">
              <span className="wss-current-label">当前壁纸</span>
              <span className="wss-current-name" title={currentTitle}>{currentTitle}</span>
            </div>
            <div className="wss-current-actions">
              <button type="button" className="wss-refresh" onClick={refreshWallpapers}>刷新</button>
              <button type="button" className="wss-cancel" onClick={() => select('')}>取消壁纸</button>
            </div>
          </div>
          <div className="wss-hero-meta">
            {currentWallpaper && <span className="wss-type-badge">{currentWallpaper.type.toUpperCase()}</span>}
            <span className="wss-hero-status" data-tone={heroStatus.tone}><i aria-hidden="true" />{heroStatus.text}</span>
            {currentWallpaper?.hasScene && <span className="wss-chip">scene.pkg</span>}
            <span className="wss-chip">{wallpapers.length} 张可用</span>
          </div>
        </div>
      </section>
      {/* 视频编码兜底：失败后在此告知原因与自救方式（只提示最近一条） */}
      {mediaFailure && (
        <section className="wss-alert wss-media-failure" data-kind={mediaFailure.kind} role="status">
          <p>{MEDIA_FAILURE_TEXT[mediaFailure.kind][mediaFailure.fallback]}</p>
          <button type="button" className="wss-media-dismiss" onClick={dismissMediaFailure}>知道了</button>
        </section>
      )}
      {/* 快捷导航：四组锚点，点击滚动定位 */}
      <nav className="wss-nav" aria-label="壁纸设置快速定位">
        {[
          ['wss-anchor-library', '壁纸库'],
          ['wss-anchor-appearance', '外观'],
          ['wss-anchor-playback', '播放'],
          ['wss-anchor-advanced', '高级'],
        ].map(([id, label]) => (
          <button key={id} type="button" className="wss-nav-item" onClick={() => jumpTo(id)}>{label}</button>
        ))}
      </nav>
      <div className="wss-group" id="wss-anchor-library">

      {/* 壁纸库：工具栏（搜索/类型/收藏/隐藏/排序）+ 16:9 缩略图卡片（类型 chip 左下、选中 ✓ 右上） */}
      <section className="wss-section">
        <header className="wss-section-head">
          <h4 className="wss-section-title">壁纸库</h4>
          <span className="wss-count">{wallpapers.length} 张</span>
        </header>
        <div className="wss-library-tools">
          <div className="wss-search-row">
            <input
              type="search"
              className="wss-search"
              placeholder="搜索壁纸标题"
              aria-label="搜索壁纸标题"
              value={filter.query}
              onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
            />
            <select
              className="wss-sort"
              aria-label="排序方式"
              value={filter.sort}
              onChange={(e) => {
                const sort = e.target.value as LibraryFilter['sort'];
                setFilter((f) => ({ ...f, sort }));
                // 面板开着时选中壁纸由 index.ts 写入最近使用；切到该排序时只重读 recent（保留会话内收藏/隐藏）。
                if (sort === 'recent') setLibState((prev) => ({ ...prev, recent: loadLibraryState().recent }));
              }}
            >
              <option value="default">默认排序</option>
              <option value="recent">最近使用</option>
              <option value="title">标题排序</option>
            </select>
          </div>
          <div className="wss-filter-row">
            <select
              className="wss-type-filter"
              aria-label="按类型筛选"
              value={filter.types[0] ?? 'all'}
              onChange={(e) => setFilter((f) => ({
                ...f,
                types: e.target.value === 'all' ? [] : [e.target.value as WallpaperKind],
              }))}
            >
              <option value="all">全部类型</option>
              <option value="scene">Scene</option>
              <option value="video">视频</option>
              <option value="web">Web</option>
              <option value="image">图片</option>
              <option value="preset">预设</option>
            </select>
            <label className="wss-tool">
              <input
                type="checkbox"
                className="wss-fav-only"
                checked={filter.favoritesOnly}
                onChange={(e) => setFilter((f) => ({ ...f, favoritesOnly: e.target.checked }))}
              />
              仅收藏
            </label>
            <label className="wss-tool">
              <input
                type="checkbox"
                className="wss-show-hidden"
                checked={filter.showHidden}
                onChange={(e) => setFilter((f) => ({ ...f, showHidden: e.target.checked }))}
              />
              显示已隐藏
            </label>
          </div>
        </div>
        <div className="wss-grid">
          {visibleWallpapers.map((w) => {
            const selected = settings?.selectedWallpaperId === w.id;
            const favorite = libState.favorites.has(w.id);
            const hidden = libState.hidden.has(w.id);
            return (
              <div key={w.id} className="wss-thumb-wrap">
                <button
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
                {/* 收藏/隐藏是卡片的兄弟节点（避免按钮嵌套）；stopPropagation 兜底不触发选壁纸 */}
                <span className="wss-thumb-actions">
                  <button
                    type="button"
                    className={'wss-fav' + (favorite ? ' wss-fav-on' : '')}
                    data-id={w.id}
                    title={favorite ? '取消收藏' : '收藏'}
                    aria-label={favorite ? '取消收藏' : '收藏'}
                    aria-pressed={favorite}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLibState((prev) => toggleFavorite(w.id, prev));
                    }}
                  >
                    {favorite ? '★' : '☆'}
                  </button>
                  <button
                    type="button"
                    className={'wss-hide' + (hidden ? ' wss-hide-on' : '')}
                    data-id={w.id}
                    title={hidden ? '取消隐藏' : '隐藏这张壁纸'}
                    aria-label={hidden ? '取消隐藏' : '隐藏这张壁纸'}
                    onClick={(e) => {
                      e.stopPropagation();
                      setLibState((prev) => toggleHidden(w.id, prev));
                    }}
                  >
                    {hidden ? '↺' : '✕'}
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        {wallpapers.length === 0 && (
          <p className="wss-empty">还没有壁纸。请在下方设置壁纸目录，或点「自动探测」。</p>
        )}
        {wallpapers.length > 0 && visibleWallpapers.length === 0 && (
          <p className="wss-empty">没有匹配的壁纸（隐藏 {libState.hidden.size} 张）</p>
        )}
      </section>
      {/* 壁纸属性（v0.9 四类型）：bool/slider/color/combo；slider/color 防抖提交，bool/combo 即时；
          提交后写 localStorage 并重装配当前壁纸（渲染器装配时读取属性值）。 */}
      {selectedIsScene && visibleProperties.length > 0 && (
        <section className="wss-section wss-userprops">
          <h4 className="wss-section-title">壁纸属性</h4>
          <p className="wss-section-desc">切换后生效（会重新装配当前壁纸）。</p>
          <div className="wss-userprops-list">
            {visibleProperties.map((property) => {
              // condition 依赖其它属性的当前值；不满足时控件禁用并标灰。
              const enabled = propertyConditionMet(property.condition, propValues);
              const disabledTitle = enabled ? undefined : '条件不满足，此属性暂不可用';
              const labelNode = (
                <span className="wss-userprop-label">
                  {property.label}
                  {!enabled && <span className="wss-userprop-hint">（条件不满足）</span>}
                </span>
              );
              const resetNode = (
                <button
                  type="button"
                  className="wss-userprop-reset"
                  data-key={property.key}
                  disabled={!enabled}
                  title={disabledTitle}
                  onClick={() => resetProperty(property)}
                >
                  恢复默认
                </button>
              );
              const current = propValues[property.key] ?? property.value;
              if (property.type === 'bool') {
                const checked = typeof current === 'boolean' ? current : property.value;
                return (
                  <div key={property.key} className="wss-userprop-item" data-key={property.key} data-disabled={enabled ? undefined : 'true'}>
                    <label className="wss-row wss-userprop-main">
                      {labelNode}
                      <input
                        type="checkbox"
                        className="wss-userprop"
                        data-key={property.key}
                        checked={checked}
                        disabled={!enabled}
                        title={disabledTitle}
                        onChange={(e) => {
                          const next = e.target.checked;
                          setPropertyValue(property.key, next);
                          commitProperty(property.key, next);
                        }}
                      />
                    </label>
                    {resetNode}
                  </div>
                );
              }
              if (property.type === 'slider') {
                const value = typeof current === 'number' && Number.isFinite(current) ? current : property.value;
                return (
                  <div key={property.key} className="wss-userprop-item" data-key={property.key} data-disabled={enabled ? undefined : 'true'}>
                    <label className="wss-slider wss-userprop-main">
                      <span className="wss-slider-head">
                        {labelNode}
                        <span className="wss-userprop-value">{formatSliderValue(value, property)}</span>
                      </span>
                      <input
                        type="range"
                        className="wss-userprop"
                        data-key={property.key}
                        min={property.min}
                        max={property.max}
                        step={sliderStep(property)}
                        value={value}
                        disabled={!enabled}
                        title={disabledTitle}
                        onChange={(e) => {
                          const next = Number(e.target.value);
                          setPropertyValue(property.key, next);
                          scheduleCommit(property.key, next);
                        }}
                        onPointerUp={() => flushCommit(property.key)}
                        onBlur={() => flushCommit(property.key)}
                      />
                    </label>
                    {resetNode}
                  </div>
                );
              }
              if (property.type === 'color') {
                const value = typeof current === 'string' ? current : property.value;
                return (
                  <div key={property.key} className="wss-userprop-item" data-key={property.key} data-disabled={enabled ? undefined : 'true'}>
                    <label className="wss-row wss-userprop-main">
                      {labelNode}
                      <input
                        type="color"
                        className="wss-userprop"
                        data-key={property.key}
                        value={colorTripletToHex(value)}
                        disabled={!enabled}
                        title={disabledTitle}
                        onChange={(e) => {
                          const next = hexToColorTriplet(e.target.value);
                          setPropertyValue(property.key, next);
                          scheduleCommit(property.key, next);
                        }}
                        onPointerUp={() => flushCommit(property.key)}
                        onBlur={() => flushCommit(property.key)}
                      />
                    </label>
                    {resetNode}
                  </div>
                );
              }
              const value = typeof current === 'string' ? current : property.value;
              return (
                <div key={property.key} className="wss-userprop-item" data-key={property.key} data-disabled={enabled ? undefined : 'true'}>
                  <label className="wss-row wss-userprop-main">
                    {labelNode}
                    <select
                      className="wss-userprop wss-userprop-select"
                      data-key={property.key}
                      value={value}
                      disabled={!enabled}
                      title={disabledTitle}
                      onChange={(e) => {
                        const next = e.target.value;
                        setPropertyValue(property.key, next);
                        commitProperty(property.key, next);
                      }}
                    >
                      {property.options.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  {resetNode}
                </div>
              );
            })}
          </div>
        </section>
      )}
      {/* 系统音频（v0.9 P1）：仅 supportsaudioprocessing 的 scene 壁纸；浏览器授权后驱动音频可视化。 */}
      {selectedIsScene && audioProcessing && (
        <section className="wss-section wss-sysaudio">
          <h4 className="wss-section-title">系统音频</h4>
          <p className="wss-section-desc">
            用系统播放的声音驱动壁纸的音频可视化。点下面按钮后，在浏览器弹窗里选择「整个屏幕」并勾选「共享音频」；
            共享期间会持续采集系统声音（不上传、不落盘），可随时停止。桌面版 App 受宿主权限限制不可用，
            请用浏览器打开本 GUI 地址后使用。
          </p>
          <div className="wss-row">
            {systemAudioState === 'active' ? (
              <button className="wss-sysaudio-stop" onClick={stopSystemAudio}>停止系统音频</button>
            ) : (
              <button
                className="wss-sysaudio-start"
                disabled={systemAudioState === 'starting'}
                onClick={() => { void startSystemAudio(); }}
              >
                {systemAudioState === 'starting' ? '等待授权…' : '启用系统音频（需授权）'}
              </button>
            )}
          </div>
          {systemAudioError && <p className="wss-section-desc wss-sysaudio-error">{systemAudioErrorMessage(systemAudioError)}</p>}
        </section>
      )}
      </div>
      <div className="wss-pair">
      {/* 显示效果：壁纸画面观感（遮罩/模糊/KenBurns/适配模式）与应用级 Glow，改完立即生效、不必重选壁纸 */}
      {settings && (
        <section className="wss-section" id="wss-anchor-appearance">
          <h4 className="wss-section-title">显示效果</h4>
          <div className="wss-effects">
            <label className="wss-slider">
              <span className="wss-slider-head">
                <span>遮罩不透明度</span>
                <span className="wss-effect-value">{settings.overlayOpacity.toFixed(2)}</span>
              </span>
              <input
                type="range"
                className="wss-overlay-opacity"
                min={0}
                max={1}
                step={0.01}
                value={settings.overlayOpacity}
                onChange={(e) => applyRuntime({ overlayOpacity: Number(e.target.value) })}
              />
            </label>
            <label className="wss-row">
              <input
                type="checkbox"
                className="wss-blur-enabled"
                checked={settings.blurEnabled}
                onChange={(e) => applyRuntime({ blurEnabled: e.target.checked })}
              />
              背景模糊
            </label>
            <label className="wss-slider">
              <span className="wss-slider-head">
                <span>模糊半径</span>
                <span className="wss-effect-value">{settings.blurRadius} px</span>
              </span>
              <input
                type="range"
                className="wss-blur-radius"
                min={0}
                max={64}
                step={1}
                value={settings.blurRadius}
                onChange={(e) => applyRuntime({ blurRadius: Number(e.target.value) })}
              />
            </label>
            <label className="wss-row">
              <input
                type="checkbox"
                className="wss-kenburns"
                checked={settings.kenBurns}
                onChange={(e) => applyRuntime({ kenBurns: e.target.checked })}
              />
              Ken Burns 缓慢缩放
            </label>
            <label className="wss-row">
              <span>画面适配</span>
              <select
                className="wss-fit-mode"
                value={settings.fitMode}
                onChange={(e) => applyRuntime({ fitMode: e.target.value as FitMode })}
              >
                <option value="cover">裁剪铺满</option>
                <option value="contain">完整显示（可能留边）</option>
                <option value="stretch">拉伸铺满</option>
              </select>
            </label>
          </div>
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
      {/* 自动轮播（v0.8）：开启后按间隔自动切换；收藏 ≥2 张时只轮播收藏，池不足 2 张时明示原因。 */}
      {settings && (
        <section className="wss-section" id="wss-anchor-playback">
          <h4 className="wss-section-title">轮播</h4>
          <div className="wss-rotation">
            <label className="wss-glow-row">
              <input
                type="checkbox"
                className="wss-rotation-enabled"
                checked={settings.rotationEnabled}
                onChange={(e) => applyRuntime({ rotationEnabled: e.target.checked })}
              />
              自动轮播
            </label>
            <label className="wss-row">
              <span>切换间隔</span>
              <select
                className="wss-rotation-interval"
                value={String(settings.rotationIntervalMs)}
                onChange={(e) => applyRuntime({ rotationIntervalMs: Number(e.target.value) })}
              >
                {/* 非面板写入的自定义间隔也如实显示（不静默归一到最近档位） */}
                {!ROTATION_INTERVAL_OPTIONS.some((o) => o.ms === settings.rotationIntervalMs) && (
                  <option value={String(settings.rotationIntervalMs)}>
                    {formatRotationInterval(settings.rotationIntervalMs)}
                  </option>
                )}
                {ROTATION_INTERVAL_OPTIONS.map((o) => (
                  <option key={o.ms} value={String(o.ms)}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="wss-row">
              <span>切换顺序</span>
              <select
                className="wss-rotation-order"
                value={normalizeRotationOrder(settings.rotationOrder)}
                onChange={(e) => applyRuntime({ rotationOrder: e.target.value as RotationOrder })}
              >
                <option value="sequential">顺序</option>
                <option value="random">随机</option>
              </select>
            </label>
            <p className="wss-section-desc wss-rotation-status" data-state={rotationPoolSize < 2 ? 'empty' : 'ready'}>
              {rotationStatus}
            </p>
          </div>
        </section>
      )}
      </div>
      <div className="wss-advanced" id="wss-anchor-advanced">
      {/* 性能与省电：同一张卡片；wss-power 仍只含两个复选框（画质档位是 select） */}
      {settings && (
        <details className="wss-details">
          <summary className="wss-details-head">
            <span className="wss-details-title">性能与省电</span>
            <span className="wss-details-hint">暂停 · 画质 · 音效</span>
          </summary>
          <div className="wss-details-body">
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
          </div>
        </details>
      )}
      {/* 文字可读性（2026-10-01，用户报告「某些壁纸文字看不清」）：贴壁纸的文字可手动指定颜色
          （自动跟随壁纸亮度 / 白 / 黑 / 自定义），并可选描边（对立色阴影，背景花哨时最有效）。
          改动经 applyRuntime → onRuntimeSettings 立即下发（index.ts 转 controller.applyTextStyle），
          不必重选壁纸；被描边作用的只有贴壁纸的透明文字，实底气泡/卡片不受影响。 */}
      {settings && (
        <details className="wss-details">
          <summary className="wss-details-head">
            <span className="wss-details-title">文字可读性</span>
            <span className="wss-details-hint">颜色 · 描边</span>
          </summary>
          <div className="wss-details-body">
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
          </div>
        </details>
      )}
      <details className="wss-details">
        <summary className="wss-details-head">
          <span className="wss-details-title">壁纸目录</span>
          <span className="wss-details-hint">{wallpaperDir && weAssetsDir ? '已配置' : '未配置'}</span>
        </summary>
        <div className="wss-details-body">
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
        </div>
      </details>
      {/* 实时渲染：状态行 + 重试/清除入口。—— 放在面板最末：它不是日常操作，
          只在「scene 壁纸渲染不出来」时才是用户唯一的自救入口。 */}
      <details className="wss-details" data-tone={liveState}>
        <summary className="wss-details-head">
          <span className="wss-details-title">实时渲染</span>
          <span className="wss-details-hint" data-tone={liveState}>{liveState === 'ok' ? '正常' : liveState === 'failed' ? '需要处理' : '待机'}</span>
        </summary>
        <div className="wss-details-body">
        <div className="wss-live-status" data-state={liveState}>
          <p className="wss-section-desc wss-live-current">{liveCurrent}</p>
          {liveMemory && <p className="wss-section-desc wss-live-memory">{liveMemory}</p>}
        </div>
        <div className="wss-row">
          <button type="button" className="wss-live-retry" onClick={retryLive}>重试实时渲染</button>
          <button type="button" className="wss-live-forget" onClick={forgetFailures}>清除失败记忆</button>
        </div>
        </div>
      </details>
      </div>
      {message && <p className="wss-message" role="status">{message}</p>}
    </div>
  );
}
