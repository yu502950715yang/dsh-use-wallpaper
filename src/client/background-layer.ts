import type { WallpaperInfo } from '../shared/types.js';
import type { BackgroundPlan, FitMode } from './types.js';
import { outlineShadow } from './text-color.js';
import { PointerPostBridge } from './pointer-post-bridge.js';
import { createVideoHealthMonitor, type VideoHealthSnapshot } from './video-health.js';
import { WEB_SOUND_MESSAGE_TAG } from '../shared/web-audio-shim.js';
import { mediaFileUrl, webWallpaperUrl } from '../shared/routes.js';

export function resolveBackground(info: WallpaperInfo): BackgroundPlan {
  // scene / preset（依赖场景）/ unknown（project.json 无 type 但含场景包）都按场景渲染。
  // 入口名来自 list（WE 模板可能是 gifscene.json，缺省 scene.json）。
  if ((info.type === 'scene' || info.type === 'preset' || info.type === 'unknown') && info.hasScene) {
    return { kind: 'scene', wallpaperId: info.id, sceneEntry: info.sceneEntry ?? 'scene.json' };
  }
  if (info.type === 'video' && info.file) {
    // hasAudio 由 host 扫描时探测（false = 素材无音轨，面板提示且不解锁声音）。
    return { kind: 'video', url: mediaFileUrl(info.id), hasAudio: info.hasAudio };
  }
  // web 壁纸：iframe 加载网页（index.html 及相对资源经 /wallpapers/web 静态服务）
  if (info.type === 'web') {
    return { kind: 'web', url: webWallpaperUrl(info.id) };
  }
  if (info.previewUrl) {
    return { kind: 'image', url: info.previewUrl, kenBurns: !info.hasPreviewGif };
  }
  return { kind: 'none' };
}

export function applyKenBurns(el: HTMLElement, enabled: boolean): void {
  el.classList.toggle('wp-kenburns', enabled);
}

export interface WebFrameLocation {
  protocol: string;
  hostname: string;
  port: string;
}

export interface WebFrameSpec {
  url: string;
  sandbox: string;
}

// web 壁纸 iframe 必须同时满足「与自身资源同源」与「与宿主跨源」（AGENT.md §5.30）：
// 沙箱不带 allow-same-origin 时的 opaque origin 会让壁纸自己的 img/video 也算跨源，
// WebGL texImage2D 抛 SecurityError ⇒ WebGL 类 web 壁纸整片空白。
// DSH webserver 同时接受 127.0.0.1 与 localhost，故用另一个回环主机名承载壁纸。
export function alternateLoopbackOrigin(loc: WebFrameLocation): string | null {
  const alt = loc.hostname === 'localhost'
    ? '127.0.0.1'
    : loc.hostname === '127.0.0.1' || loc.hostname === '::1' || loc.hostname === '[::1]'
      ? 'localhost'
      : null;
  return alt === null ? null : `${loc.protocol}//${alt}${loc.port ? ':' + loc.port : ''}`;
}

// 桌面壳（DeepSeek Harness 桌面版）的 GUI 由自定义协议 `dsh-app://app` 承载，没有可互换的回环
// 主机名。其官方接缝是 `globalThis.__DSH_TRANSPORT__.streamBaseUrl`（= 宿主真实 HTTP origin；
// 见 @deepseek-ai/dsh-client-connection README，api-gateway 亦用它做流式传输基址）。
export interface TransportGlobals {
  __DSH_TRANSPORT__?: { streamBaseUrl?: unknown };
}

// 读 origin：只认 http(s)（其它协议无法承载壁纸），并规范化掉路径与查询串。
export function readTransportOrigin(globals: TransportGlobals = globalThis as TransportGlobals): string | null {
  const raw = globals.__DSH_TRANSPORT__?.streamBaseUrl;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

export type WebFrameOriginPlan =
  | { kind: 'transport'; origin: string }   // 桌面壳：宿主 HTTP origin（权威，无需探活）
  | { kind: 'probe'; alternate: string }    // 回环页（dsh web）：另一回环主机名，需探活
  | { kind: 'fallback' };                   // 其余：同源 + 纯 allow-scripts（隔离优先，降级）

// 承载 origin 的优先级（AGENT.md §5.30）：
// ① 桌面壳公布的宿主 HTTP origin —— 否则 dsh-app:// 页面只能落 opaque origin，WebGL 类壁纸空白；
// ② 页面本身是回环名 → 沿用「另一回环主机名」+ 探活（dsh web 原有行为，不变）；
// ③ 其余（局域网 IP / 隧道）→ 退回 opaque origin 兜底。
// 与页面**同源**的 transport origin 不采用：iframe 必须与宿主页跨源，否则隔离失效。
export function planWebFrameOrigin(loc: WebFrameLocation, transportOrigin: string | null): WebFrameOriginPlan {
  const pageOrigin = `${loc.protocol}//${loc.hostname}${loc.port ? ':' + loc.port : ''}`;
  if (transportOrigin !== null && transportOrigin !== pageOrigin) return { kind: 'transport', origin: transportOrigin };
  const alternate = alternateLoopbackOrigin(loc);
  return alternate === null ? { kind: 'fallback' } : { kind: 'probe', alternate };
}

// 另一主机名可达 → 壁纸与宿主跨源，故可保留 allow-same-origin（沙箱其余限制仍在，且拿不到 GUI DOM）；
// 不可达 → 退回同源 + 纯 allow-scripts：隔离优先，WebGL 类壁纸降级（空白）。
export function webFrameSpec(wallpaperPath: string, loc: WebFrameLocation, altOrigin: string | null): WebFrameSpec {
  const origin = altOrigin ?? `${loc.protocol}//${loc.hostname}${loc.port ? ':' + loc.port : ''}`;
  return { url: origin + wallpaperPath, sandbox: altOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts' };
}

// web 壁纸 resize 自适应（2026-09-22，用户报告「调整浏览器大小时不跟着自适应」）：
// 部分 web 壁纸的脚本在初始化时把画布尺寸**快照**成 window.innerWidth/Height（实测
// `3789244610` 的 index.min.js，且全 bundle 无 resize 监听），窗口变化后画面不再变。
// 宿主 iframe 与子帧视口都正确跟随（headless 实测），跨源 iframe 又无法注入脚本
// ⇒ 只能按新视口**重建 iframe** 让壁纸重新初始化（重建实测有效）。
// debounce 到尺寸稳定后只重建一次；重建期保留旧帧直到新帧 load（不留白）。
export const WEB_RESIZE_RELOAD_DELAY_MS = 300;
export const WEB_RESIZE_RELOAD_TIMEOUT_MS = 8000;
// 视频首帧兜底：1.5s 内没有 loadeddata（编码不受支持/文件异常时浏览器可能既不 error 也不出帧）。
export const VIDEO_LOAD_TIMEOUT_MS = 1500;

export type VideoLoadResult = 'ok' | 'unsupported' | 'timeout';

/** 视频壁纸的播放选项（声音策略）。 */
export interface VideoPlayOptions {
  /** false = 素材已探测为无音轨（不解锁声音）；undefined = 未知，按可能有音轨处理。 */
  hasAudio?: boolean;
  /** true = 强制静音：scene 降级链的内嵌视频不播放声音（WE 视频纹理无声，保持既有行为）。 */
  silent?: boolean;
}

/** 背景层创建选项（测试可注入；缺省按真实宿主判断）。 */
export interface BackgroundLayerOptions {
  /** 壁纸声音总开关（scene 音效 + 视频壁纸音轨），缺省 true。 */
  soundEnabled?: boolean;
  /** 视频壁纸音量 0-1，缺省 1。 */
  volume?: number;
  /** 桌面壳（dsh-app://）：Electron 默认允许有声自动播放；缺省按 location.protocol 判断。 */
  desktopShell?: boolean;
}

export interface BackgroundLayer {
  root: HTMLElement;
  showImage(url: string, kenBurns: boolean): void;
  /** 加载视频并等首帧：error → unsupported，1.5s 无 loadeddata → timeout。 */
  showVideo(url: string, opts?: VideoPlayOptions): Promise<VideoLoadResult>;
  showWeb(url: string): void;
  showSceneCanvas(canvas: HTMLCanvasElement, blurCanvas?: HTMLCanvasElement): void;
  showNone(): void;
  setOverlayOpacity(v: number): void;
  setBlur(enabled: boolean, radius: number): void;
  /** 设置 Ken Burns 开关状态并即时应用到当前图片（不重建元素）。 */
  setKenBurns(enabled: boolean): void;
  /** 运行期切换画面适配模式（当前图片/视频即时生效）。 */
  setFitMode(mode: FitMode): void;
  setChatFg(color: string): void;
  /** 文字描边（对立色阴影）：level 0 或空颜色 = 移除变量（无描边，既有观感）。 */
  setChatOutline(color: string, level: number): void;
  /** 省电：暂停/恢复视频壁纸播放（scene 由渲染器负责；web 壁纸在 iframe 里无法受控）。 */
  setPaused(paused: boolean): void;
  /** 壁纸声音总开关：关 → 视频壁纸立即静音（画面继续）；开 → 有音轨则按宿主策略恢复。 */
  setSoundEnabled(enabled: boolean): void;
  /** 视频壁纸音量 0-1（运行期即时生效）。 */
  setVolume(volume: number): void;
  /** 视频壁纸健康快照（FPS/丢帧/循环停顿）；当前不是视频壁纸时返回 null。 */
  getVideoHealth(): VideoHealthSnapshot | null;
}

/** 音量归一：非法/缺失回退 1，越界 clamp 0-1。 */
function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

/** 桌面壳页面（dsh-app://）由 Electron 承载：默认 autoplayPolicy=no-user-gesture-required。 */
function isDesktopShellProtocol(): boolean {
  try { return typeof location !== 'undefined' && location.protocol === 'dsh-app:'; } catch { return false; }
}

/** 页面是否已有用户激活（浏览器自动播放策略：有手势后非静音播放才被允许）。 */
function hasUserActivation(): boolean {
  try {
    const ua = (navigator as unknown as { userActivation?: { hasBeenActive?: boolean } }).userActivation;
    return ua?.hasBeenActive === true;
  } catch { return false; }
}

/** play() 的失败/未实现（jsdom）都吞掉：声音是增强项，不得影响画面。 */
function playVideo(video: HTMLVideoElement): void {
  try { void video.play()?.catch?.(() => {}); } catch { /* 环境不支持 */ }
}

export function createBackgroundLayer(root: HTMLElement, opts: BackgroundLayerOptions = {}): BackgroundLayer {
  root.classList.add('wp-background-layer');
  let soundEnabled = opts.soundEnabled ?? true;
  let volume = clampVolume(opts.volume ?? 1);
  const desktopShell = opts.desktopShell ?? isDesktopShellProtocol();
  const fill = document.createElement('div');
  fill.className = 'wp-bg-fill';
  root.appendChild(fill);
  const overlay = document.createElement('div');
  overlay.className = 'wp-bg-overlay';
  root.appendChild(overlay);

  // frameToken：每次背景变更递增，作废尚未落地的 web iframe（另一主机名的探活是异步的）
  let frameToken = 0;
  let altOriginProbe: Promise<string | null> | null = null;
  // 探活结果：重建帧时复用（探活只与另一主机名可达性有关，与路径无关）
  let altOrigin: string | null = null;
  // 指针直传：web 帧可见期间由 bridge 挂 pointermove 并 postMessage 进 iframe。
  const pointerPost = new PointerPostBridge();

  // 省电状态与当前视频元素（setPaused 对后者 pause/play）。
  let paused = false;
  let currentVideo: HTMLVideoElement | null = null;
  // 视频声音：当前素材是否有音轨（false = 已知无音轨）+ 浏览器手势解锁监听（null = 无）。
  let currentVideoHasAudio: boolean | undefined;
  let gestureUnlock: (() => void) | null = null;
  // 视频健康采样：随 <video> 生命周期 attach/detach（面板与 __wallpaperEngine 排查用）。
  const videoHealth = createVideoHealthMonitor();
  // 当前显示的图片与适配模式：供运行期切换（不重建元素）。
  let currentImage: HTMLImageElement | null = null;
  // 当前图片是否允许 Ken Burns（GIF 预览为 false）：面板只能关，不能重新打开。
  let currentImageKenBurnsAllowed = false;
  // 用户的 Ken Burns 开关状态：跨图片保留，供 showImage 等非面板路径复用（默认 true 同 DEFAULTS）。
  let kenBurnsEnabled = true;
  let fitMode: FitMode = 'cover';

  function applyFit(el: HTMLElement | null): void {
    if (!el) return;
    el.style.objectFit = fitMode === 'stretch' ? 'fill' : fitMode;
  }

  // web 自适应状态：当前 web URL、已落地的 web 帧、基准视口、debounce 定时器、正在预载的帧
  let webUrl: string | null = null;
  let liveWebFrame: HTMLIFrameElement | null = null;
  let viewW = 0;
  let viewH = 0;
  let webResizeTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingWebFrame: HTMLIFrameElement | null = null;
  let resizeListening = false;
  // iframe 内 shim 的安装时机不可控（首条消息可能在它装好前发出而丢失）：
  // 帧创建后短期内定时重发，覆盖 shim 就绪窗口；之后靠 load/设置变更补发。
  const WEB_SOUND_RETRY_INTERVAL_MS = 250;
  const WEB_SOUND_RETRY_MAX = 20; // ≈5s
  let soundRetryTimer: ReturnType<typeof setInterval> | null = null;

  // 停掉 web 自适应（切到非 web 背景、清空背景、或换下一张 web 时调用）
  function stopWebResizeReload(): void {
    webUrl = null;
    liveWebFrame = null;
    pointerPost.detach();
    stopSoundRetry();
    if (webResizeTimer !== null) { clearTimeout(webResizeTimer); webResizeTimer = null; }
    pendingWebFrame?.remove();
    pendingWebFrame = null;
    if (resizeListening) { window.removeEventListener('resize', onWindowResize); resizeListening = false; }
  }

  function clear() {
    frameToken += 1;
    videoHealth.detach();
    detachGestureUnlock();
    fill.replaceChildren();
    currentImage = null;
    currentImageKenBurnsAllowed = false;
    currentVideo = null;
    currentVideoHasAudio = undefined;
    stopWebResizeReload();
  }

  function detachGestureUnlock(): void {
    if (!gestureUnlock) return;
    window.removeEventListener('pointerdown', gestureUnlock, true);
    window.removeEventListener('keydown', gestureUnlock, true);
    gestureUnlock = null;
  }

  function armGestureUnlock(): void {
    if (gestureUnlock) return;
    gestureUnlock = () => {
      detachGestureUnlock();
      const video = currentVideo;
      if (!video || !soundEnabled || currentVideoHasAudio === false) return;
      video.muted = false; // 手势回调内改 muted：自动播放策略允许非静音播放
      playVideo(video);
    };
    window.addEventListener('pointerdown', gestureUnlock, true);
    window.addEventListener('keydown', gestureUnlock, true);
  }

  // 声音策略：关 / 无音轨 ⇒ 静音；桌面壳或页面已激活 ⇒ 直接出声；
  // 浏览器无手势 ⇒ 先静音起播保画面，首次 pointerdown/keydown 解锁。
  function applyVideoSound(video: HTMLVideoElement): void {
    if (!soundEnabled || currentVideoHasAudio === false) {
      video.muted = true;
      detachGestureUnlock();
      return;
    }
    if (desktopShell || hasUserActivation()) {
      video.muted = false;
      detachGestureUnlock();
      return;
    }
    video.muted = true;
    armGestureUnlock();
  }

  // 探活：另一主机名上同一路径能取到即视为可达。no-cors 读不到响应体（跨源），
  // 故只有网络层失败才 reject —— 401/404 也算「该主机名可达」。
  function probeAlternateOrigin(alt: string, wallpaperPath: string): Promise<string | null> {
    if (typeof fetch !== 'function') return Promise.resolve(null);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1000);
    return fetch(alt + wallpaperPath, { mode: 'no-cors', signal: ac.signal })
      .then(() => alt, () => null)
      .finally(() => clearTimeout(timer));
  }

  // ⚠️ **切勿在建元素时赋 src**（2026-09-30 真机 bug）：未挂载的 iframe 一旦有 src 就立刻开始加载，
  // 而跨源子帧（OOPIF）冷启动时父帧尚未给它分配盒子尺寸 ⇒ 子帧的 `window.innerWidth/Height` 读到 **0**。
  // 壁纸 `3789244610` 初始化时把画布尺寸快照成视口（且自身无 resize 监听）⇒ 画布永远停在 0×0，
  // 启动后一直空白，只有用户调整窗口大小触发重建 iframe（此时站点实例已存在、视口正确）才显示。
  function makeWebFrame(spec: WebFrameSpec): HTMLIFrameElement {
    const frame = document.createElement('iframe');
    frame.className = 'wp-scene-canvas'; // 复用铺满尺寸样式
    frame.setAttribute('sandbox', spec.sandbox);
    frame.setAttribute('allow', 'autoplay; fullscreen');
    // 壁纸是背景、永不滚动：壁纸文档自身溢出时滚动条会吃掉视口（Firefox 实测 17px×2），
    // 其 100vw / innerWidth 尺寸又会因此反撑出另一条（AGENT.md §5.30）。
    frame.setAttribute('scrolling', 'no');
    return frame;
  }

  // 挂载 → 强制一次布局 → 再赋 src：**顺序即修复本身，勿调换**（见 makeWebFrame 注释）。
  function appendWebFrame(frame: HTMLIFrameElement, url: string): void {
    fill.appendChild(frame);
    frame.getBoundingClientRect(); // 强制父帧完成布局，使子帧初始视口 = 元素盒子尺寸
    frame.src = url;
  }

  // web 壁纸声音：宿主拿不到跨源 iframe 的 DOM ⇒ 把开关/音量 postMessage 给 host 注入的 shim。
  function postSoundToFrame(frame: HTMLIFrameElement | null): void {
    const win = frame?.contentWindow;
    if (!win) return;
    try {
      win.postMessage({ [WEB_SOUND_MESSAGE_TAG]: 1, enabled: soundEnabled, volume }, '*');
    } catch {
      // 帧已卸载/被限制：忽略（web 壁纸声音保持网页原状）
    }
  }

  function syncWebSound(): void {
    if (webUrl && liveWebFrame) postSoundToFrame(liveWebFrame);
  }

  function stopSoundRetry(): void {
    if (soundRetryTimer !== null) { clearInterval(soundRetryTimer); soundRetryTimer = null; }
  }

  // 帧刚创建时 shim 还没执行：定时重发同一条设置，直到 shim 就绪或达到次数上限。
  function retrySoundPost(frame: HTMLIFrameElement): void {
    stopSoundRetry();
    let attempts = 0;
    soundRetryTimer = setInterval(() => {
      attempts += 1;
      if (attempts > WEB_SOUND_RETRY_MAX || (frame !== liveWebFrame && frame !== pendingWebFrame)) {
        stopSoundRetry();
        return;
      }
      postSoundToFrame(frame);
    }, WEB_SOUND_RETRY_INTERVAL_MS);
  }

  function attachWebFrame(spec: WebFrameSpec): void {
    const frame = makeWebFrame(spec);
    liveWebFrame = frame;
    // shim 可能晚于首条消息执行 ⇒ load 后再补发一次（首条早到会被丢）。
    frame.addEventListener('load', () => { if (liveWebFrame === frame) postSoundToFrame(frame); }, { once: true });
    appendWebFrame(frame, spec.url);
    pointerPost.attach(frame);
    postSoundToFrame(frame);
    retrySoundPost(frame);
  }

  function currentViewport(): [number, number] {
    return [Math.max(1, Math.round(window.innerWidth || 0)), Math.max(1, Math.round(window.innerHeight || 0))];
  }

  // 尺寸稳定后按新视口重建（见 WEB_RESIZE_RELOAD_DELAY_MS 处说明）。
  function onWindowResize(): void {
    if (!webUrl) return;
    const [w, h] = currentViewport();
    if (w === viewW && h === viewH) return; // 尺寸没变（如仅滚动条/dpr 变化）不重建
    viewW = w;
    viewH = h;
    if (webResizeTimer !== null) clearTimeout(webResizeTimer);
    webResizeTimer = setTimeout(reloadWebFrame, WEB_RESIZE_RELOAD_DELAY_MS);
  }

  function reloadWebFrame(): void {
    webResizeTimer = null;
    const url = webUrl;
    if (!url || !liveWebFrame || !liveWebFrame.isConnected) return;
    pendingWebFrame?.remove(); // 上一次预载作废（其 settle 靠 isConnected 判定，见下）
    pendingWebFrame = null;
    const token = frameToken;
    const spec = webFrameSpec(url, window.location, altOrigin);
    const frame = makeWebFrame(spec);
    // 预载期不遮挡旧帧；用 visibility（而非 display）保留布局 ⇒ 壁纸读到的视口尺寸仍正确
    frame.style.visibility = 'hidden';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (pendingWebFrame === frame) pendingWebFrame = null;
      // 期间已切换/清空（token 变）或帧已被移除 ⇒ 丢弃；预载失败则保留旧帧（宁可尺寸不对也不留白）
      if (ok && token === frameToken && webUrl === url && frame.isConnected) {
        fill.replaceChildren(frame);
        liveWebFrame = frame;
        frame.style.visibility = '';
        pointerPost.attach(frame); // 指针直传跟着**可见**帧走（预载帧在 hidden 期间不该收坐标）
        postSoundToFrame(frame);  // 重建后的新帧同样需要声音设置；shim 可能还没装 ⇒ 重发兜底
        retrySoundPost(frame);
      } else {
        frame.remove();
      }
    };
    pendingWebFrame = frame;
    frame.addEventListener('load', () => settle(true), { once: true });
    timer = setTimeout(() => settle(false), WEB_RESIZE_RELOAD_TIMEOUT_MS);
    appendWebFrame(frame, spec.url); // 挂载 → 布局 → src（同 attachWebFrame 的不变量）
  }

  // 壁纸激活标记：有壁纸时挂 data-we-wallpaper（styles.ts 主题分支作用域），
  // 无壁纸时移除——背景透明化/文字对比度提升仅在有壁纸时生效（浅色模式适配）。
  function markActive(): void {
    document.body.setAttribute('data-we-wallpaper', 'true');
  }
  function markInactive(): void {
    document.body.removeAttribute('data-we-wallpaper');
  }

  return {
    root,
    showImage(url, kenBurns) {
      clear();
      const img = document.createElement('img');
      img.src = url;
      applyFit(img);
      currentImageKenBurnsAllowed = kenBurns;
      applyKenBurns(img, kenBurnsEnabled && kenBurns);
      fill.appendChild(img);
      currentImage = img;
      markActive();
    },
    showVideo(url, videoOpts) {
      clear();
      const video = document.createElement('video');
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.volume = volume;
      applyFit(video);
      currentVideo = video;
      currentVideoHasAudio = videoOpts?.silent === true ? false : videoOpts?.hasAudio;
      // 先注册监听与超时再赋 src：缓存命中时事件可能紧跟 src 同步到达，晚注册会漏掉。
      // clear() 换掉旧视频时不等旧 Promise：超时会兜底收尾，避免永久悬挂。
      const result = new Promise<VideoLoadResult>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        // 成功/失败/超时都要落定一次并清掉定时器（否则测试与生产都留悬挂 timer）。
        const done = (r: VideoLoadResult) => {
          if (settled) return;
          settled = true;
          if (timer !== null) clearTimeout(timer);
          resolve(r);
        };
        timer = setTimeout(() => done('timeout'), VIDEO_LOAD_TIMEOUT_MS);
        video.addEventListener('loadeddata', () => done('ok'), { once: true });
        video.addEventListener('error', () => done('unsupported'), { once: true });
      });
      video.src = url;
      fill.appendChild(video);
      videoHealth.attach(video);
      if (!videoOpts?.silent) applyVideoSound(video);
      if (paused) video.pause(); // 暂停态下换壁纸：新视频同样不播
      markActive();
      return result;
    },
    showWeb(url) {
      stopWebResizeReload(); // 先停上一轮 web 的 debounce/预载（旧帧留到新帧就绪再撤）
      // 旧背景留到新 iframe 就绪再清，避免探活期间白屏
      const token = ++frameToken;
      markActive();
      webUrl = url;
      [viewW, viewH] = currentViewport(); // 基准视口：重建时判断尺寸是否真的变了
      if (!resizeListening) { window.addEventListener('resize', onWindowResize); resizeListening = true; }
      const loc = window.location;
      const plan = planWebFrameOrigin(loc, readTransportOrigin());
      if (plan.kind === 'transport') {
        // 桌面壳：宿主 HTTP origin 由壳保证可达（它自己就用它做流式传输）⇒ 不探活。缓存给重建帧复用。
        altOrigin = plan.origin;
        fill.replaceChildren();
        attachWebFrame(webFrameSpec(url, loc, plan.origin));
        return;
      }
      if (plan.kind === 'fallback') {
        fill.replaceChildren();
        attachWebFrame(webFrameSpec(url, loc, null));
        return;
      }
      const alt = plan.alternate;
      altOriginProbe ??= probeAlternateOrigin(alt, url).then((origin) => { altOrigin = origin; return origin; });
      void altOriginProbe.then((origin) => {
        if (token !== frameToken) return; // 期间已切换/清空 → 丢弃
        fill.replaceChildren();
        attachWebFrame(webFrameSpec(url, loc, origin));
      });
    },
    showSceneCanvas(canvas, blurCanvas) {
      clear();
      // 「完整显示 + 边缘模糊填充」：先铺 cover 渲染的背景 canvas（CSS 模糊放大），
      // 再叠 contain 渲染的前景 canvas（透明边缘露出模糊背景）。
      if (blurCanvas) {
        // ⚠️ 防御：模糊层 canvas 的**渲染缓冲**必须与前景 canvas 一致（= 视口×dpr）。
        // 2026-09-10 Task5：曾出现「模糊层 canvas 从未被设尺寸 → 停在 HTML 默认 300×150，
        // 却被 `.wp-scene-blur{width:100%;height:100%;transform:scale(1.1)}` 拉伸到全屏」，
        // 且因它 DOM 序在前，`document.querySelector('canvas')` 读到的是它（300×150）而非真正
        // 渲染的那个 canvas，误导排查。此处按前景缓冲对齐（前景未设尺寸时保持原值不动）。
        if (canvas.width > 0) blurCanvas.width = canvas.width;
        if (canvas.height > 0) blurCanvas.height = canvas.height;
        blurCanvas.classList.add('wp-scene-blur');
        fill.appendChild(blurCanvas);
      }
      canvas.classList.add('wp-scene-canvas');
      fill.appendChild(canvas);
      markActive();
    },
    showNone() { clear(); markInactive(); },
    setOverlayOpacity(v) { overlay.style.opacity = String(v); },
    setBlur(enabled, radius) {
      fill.style.filter = enabled ? `blur(${radius}px)` : '';
    },
    setKenBurns(enabled) {
      kenBurnsEnabled = enabled;
      if (currentImage) applyKenBurns(currentImage, kenBurnsEnabled && currentImageKenBurnsAllowed);
    },
    setFitMode(mode) {
      fitMode = mode;
      applyFit(currentImage);
      applyFit(currentVideo);
    },
    // 文字颜色跟随壁纸亮度（2026-09-03）：把颜色写为 --wp-chat-fg，
    // styles.ts 消息列文字消费者用它；null/空则移除（回主题默认）。移除时删变量。
    setChatFg(color) {
      if (!color) document.documentElement.style.removeProperty('--wp-chat-fg');
      else document.documentElement.style.setProperty('--wp-chat-fg', color);
    },
    // 文字描边（2026-10-01）：与文字色同源——按文字色亮度取对立色阴影（亮字深边/暗字亮边），
    // 写在 --wp-chat-outline，由 styles.ts 的贴壁纸文字消费者读取。0 档/空色 = 移除变量，
    // 消费者 fallback 到 none ⇒ 默认观感与加此功能前一致（零回归）。
    setChatOutline(color, level) {
      const shadow = color ? outlineShadow(color, level) : null;
      if (!shadow) document.documentElement.style.removeProperty('--wp-chat-outline');
      else document.documentElement.style.setProperty('--wp-chat-outline', shadow);
    },
    // 省电：视频壁纸停/续播（web 壁纸在 iframe 内，插件无法控制）。
    setPaused(value) {
      paused = value;
      if (!currentVideo) return;
      if (value) currentVideo.pause();
      else playVideo(currentVideo);
    },
    // 声音总开关（scene 音效在渲染器侧；这里管视频壁纸）：关立即静音、开按宿主策略恢复。
    setSoundEnabled(enabled) {
      soundEnabled = enabled;
      syncWebSound(); // web 壁纸：无条件下发（没有 currentVideo 也要同步）
      if (!currentVideo) return;
      if (!enabled) {
        currentVideo.muted = true;
        detachGestureUnlock();
        return;
      }
      applyVideoSound(currentVideo);
    },
    // 视频壁纸音量：运行期即时生效（0-1，非法值回退 1）。
    setVolume(value) {
      volume = clampVolume(value);
      if (currentVideo) currentVideo.volume = volume;
      syncWebSound(); // web 壁纸：音量同样即时下发
    },
    getVideoHealth() {
      return videoHealth.snapshot();
    },
  };
}
