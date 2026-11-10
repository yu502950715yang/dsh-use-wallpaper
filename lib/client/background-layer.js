import { outlineShadow } from './text-color.js';
import { computePointerPost } from './pointer-post.js';
import { createVideoHealthMonitor } from './video-health.js';
import { WEB_SOUND_MESSAGE_TAG } from '../shared/web-audio-shim.js';
import { mediaFileUrl, webWallpaperUrl } from '../shared/routes.js';
export function resolveBackground(info) {
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
export function applyKenBurns(el, enabled) {
    el.classList.toggle('wp-kenburns', enabled);
}
// web 壁纸 iframe 必须同时满足「与自身资源同源」与「与宿主跨源」（AGENT.md §5.30）：
// 沙箱不带 allow-same-origin 时的 opaque origin 会让壁纸自己的 img/video 也算跨源，
// WebGL texImage2D 抛 SecurityError ⇒ WebGL 类 web 壁纸整片空白。
// DSH webserver 同时接受 127.0.0.1 与 localhost，故用另一个回环主机名承载壁纸。
export function alternateLoopbackOrigin(loc) {
    const alt = loc.hostname === 'localhost'
        ? '127.0.0.1'
        : loc.hostname === '127.0.0.1' || loc.hostname === '::1' || loc.hostname === '[::1]'
            ? 'localhost'
            : null;
    return alt === null ? null : `${loc.protocol}//${alt}${loc.port ? ':' + loc.port : ''}`;
}
// 读 origin：只认 http(s)（其它协议无法承载壁纸），并规范化掉路径与查询串。
export function readTransportOrigin(globals = globalThis) {
    const raw = globals.__DSH_TRANSPORT__?.streamBaseUrl;
    if (typeof raw !== 'string' || raw === '')
        return null;
    try {
        const url = new URL(raw);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
    }
    catch {
        return null;
    }
}
// 承载 origin 的优先级（AGENT.md §5.30）：
// ① 桌面壳公布的宿主 HTTP origin —— 否则 dsh-app:// 页面只能落 opaque origin，WebGL 类壁纸空白；
// ② 页面本身是回环名 → 沿用「另一回环主机名」+ 探活（dsh web 原有行为，不变）；
// ③ 其余（局域网 IP / 隧道）→ 退回 opaque origin 兜底。
// 与页面**同源**的 transport origin 不采用：iframe 必须与宿主页跨源，否则隔离失效。
export function planWebFrameOrigin(loc, transportOrigin) {
    const pageOrigin = `${loc.protocol}//${loc.hostname}${loc.port ? ':' + loc.port : ''}`;
    if (transportOrigin !== null && transportOrigin !== pageOrigin)
        return { kind: 'transport', origin: transportOrigin };
    const alternate = alternateLoopbackOrigin(loc);
    return alternate === null ? { kind: 'fallback' } : { kind: 'probe', alternate };
}
// 另一主机名可达 → 壁纸与宿主跨源，故可保留 allow-same-origin（沙箱其余限制仍在，且拿不到 GUI DOM）；
// 不可达 → 退回同源 + 纯 allow-scripts：隔离优先，WebGL 类壁纸降级（空白）。
export function webFrameSpec(wallpaperPath, loc, altOrigin) {
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
/** 音量归一：非法/缺失回退 1，越界 clamp 0-1。 */
function clampVolume(value) {
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}
/** 桌面壳页面（dsh-app://）由 Electron 承载：默认 autoplayPolicy=no-user-gesture-required。 */
function isDesktopShellProtocol() {
    try {
        return typeof location !== 'undefined' && location.protocol === 'dsh-app:';
    }
    catch {
        return false;
    }
}
/** 页面是否已有用户激活（浏览器自动播放策略：有手势后非静音播放才被允许）。 */
function hasUserActivation() {
    try {
        const ua = navigator.userActivation;
        return ua?.hasBeenActive === true;
    }
    catch {
        return false;
    }
}
/** play() 的失败/未实现（jsdom）都吞掉：声音是增强项，不得影响画面。 */
function playVideo(video) {
    try {
        void video.play()?.catch?.(() => { });
    }
    catch { /* 环境不支持 */ }
}
export function createBackgroundLayer(root, opts = {}) {
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
    let altOriginProbe = null;
    // 探活结果：重建帧时复用（探活只与另一主机名可达性有关，与路径无关）
    let altOrigin = null;
    // 指针直传（AGENT.md §5.48）：背景层是 pointer-events:none ⇒ 鼠标进不了 iframe，视差类 web
    // 壁纸（jquery.parallax 等）恒为静态；故由宿主把指针坐标 postMessage 进去，iframe 内 shim 合成
    // mousemove。卸载时必须摘监听，否则 HMR/切壁纸会叠加。
    let pointerPostToken = 0;
    let pointerPostFn = null;
    let pointerTarget = null;
    function detachPointerPost() {
        pointerPostToken += 1;
        if (pointerPostFn)
            window.removeEventListener('pointermove', pointerPostFn, true);
        pointerPostFn = null;
        pointerTarget = null;
    }
    // 只有在 web 帧存活期间才挂：非 web 背景不该为它付监听成本。
    function attachPointerPost(frame) {
        pointerPostToken += 1;
        const token = pointerPostToken;
        pointerTarget = frame.contentWindow;
        const onMove = (ev) => {
            const fwin = frame.contentWindow;
            // token 变 / 帧已换（resize 重建）/ 帧已摘除（预载用的隐藏帧）/ 窗口不可达 ⇒ 丢弃，不往错的帧发坐标。
            if (token !== pointerPostToken || !fwin || fwin !== pointerTarget || !frame.isConnected)
                return;
            const payload = computePointerPost(ev, frame.getBoundingClientRect(), 1);
            if (!payload)
                return;
            try {
                fwin.postMessage(payload, '*');
            }
            catch { /* 帧已卸载：忽略 */ }
        };
        pointerPostFn = onMove;
        window.addEventListener('pointermove', onMove, { capture: true, passive: true });
    }
    // 省电状态与当前视频元素（setPaused 对后者 pause/play）。
    let paused = false;
    let currentVideo = null;
    // 视频声音：当前素材是否有音轨（false = 已知无音轨）+ 浏览器手势解锁监听（null = 无）。
    let currentVideoHasAudio;
    let gestureUnlock = null;
    // 视频健康采样：随 <video> 生命周期 attach/detach（面板与 __wallpaperEngine 排查用）。
    const videoHealth = createVideoHealthMonitor();
    // 当前显示的图片与适配模式：供运行期切换（不重建元素）。
    let currentImage = null;
    // 当前图片是否允许 Ken Burns（GIF 预览为 false）：面板只能关，不能重新打开。
    let currentImageKenBurnsAllowed = false;
    // 用户的 Ken Burns 开关状态：跨图片保留，供 showImage 等非面板路径复用（默认 true 同 DEFAULTS）。
    let kenBurnsEnabled = true;
    let fitMode = 'cover';
    function applyFit(el) {
        if (!el)
            return;
        el.style.objectFit = fitMode === 'stretch' ? 'fill' : fitMode;
    }
    // web 自适应状态：当前 web URL、已落地的 web 帧、基准视口、debounce 定时器、正在预载的帧
    let webUrl = null;
    let liveWebFrame = null;
    let viewW = 0;
    let viewH = 0;
    let webResizeTimer = null;
    let pendingWebFrame = null;
    let resizeListening = false;
    // iframe 内 shim 的安装时机不可控（首条消息可能在它装好前发出而丢失）：
    // 帧创建后短期内定时重发，覆盖 shim 就绪窗口；之后靠 load/设置变更补发。
    const WEB_SOUND_RETRY_INTERVAL_MS = 250;
    const WEB_SOUND_RETRY_MAX = 20; // ≈5s
    let soundRetryTimer = null;
    // 停掉 web 自适应（切到非 web 背景、清空背景、或换下一张 web 时调用）
    function stopWebResizeReload() {
        webUrl = null;
        liveWebFrame = null;
        detachPointerPost();
        stopSoundRetry();
        if (webResizeTimer !== null) {
            clearTimeout(webResizeTimer);
            webResizeTimer = null;
        }
        pendingWebFrame?.remove();
        pendingWebFrame = null;
        if (resizeListening) {
            window.removeEventListener('resize', onWindowResize);
            resizeListening = false;
        }
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
    function detachGestureUnlock() {
        if (!gestureUnlock)
            return;
        window.removeEventListener('pointerdown', gestureUnlock, true);
        window.removeEventListener('keydown', gestureUnlock, true);
        gestureUnlock = null;
    }
    function armGestureUnlock() {
        if (gestureUnlock)
            return;
        gestureUnlock = () => {
            detachGestureUnlock();
            const video = currentVideo;
            if (!video || !soundEnabled || currentVideoHasAudio === false)
                return;
            video.muted = false; // 手势回调内改 muted：自动播放策略允许非静音播放
            playVideo(video);
        };
        window.addEventListener('pointerdown', gestureUnlock, true);
        window.addEventListener('keydown', gestureUnlock, true);
    }
    // 声音策略：关 / 无音轨 ⇒ 静音；桌面壳或页面已激活 ⇒ 直接出声；
    // 浏览器无手势 ⇒ 先静音起播保画面，首次 pointerdown/keydown 解锁。
    function applyVideoSound(video) {
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
    function probeAlternateOrigin(alt, wallpaperPath) {
        if (typeof fetch !== 'function')
            return Promise.resolve(null);
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
    function makeWebFrame(spec) {
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
    function appendWebFrame(frame, url) {
        fill.appendChild(frame);
        frame.getBoundingClientRect(); // 强制父帧完成布局，使子帧初始视口 = 元素盒子尺寸
        frame.src = url;
    }
    // web 壁纸声音：宿主拿不到跨源 iframe 的 DOM ⇒ 把开关/音量 postMessage 给 host 注入的 shim。
    function postSoundToFrame(frame) {
        const win = frame?.contentWindow;
        if (!win)
            return;
        try {
            win.postMessage({ [WEB_SOUND_MESSAGE_TAG]: 1, enabled: soundEnabled, volume }, '*');
        }
        catch {
            // 帧已卸载/被限制：忽略（web 壁纸声音保持网页原状）
        }
    }
    function syncWebSound() {
        if (webUrl && liveWebFrame)
            postSoundToFrame(liveWebFrame);
    }
    function stopSoundRetry() {
        if (soundRetryTimer !== null) {
            clearInterval(soundRetryTimer);
            soundRetryTimer = null;
        }
    }
    // 帧刚创建时 shim 还没执行：定时重发同一条设置，直到 shim 就绪或达到次数上限。
    function retrySoundPost(frame) {
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
    function attachWebFrame(spec) {
        const frame = makeWebFrame(spec);
        liveWebFrame = frame;
        // shim 可能晚于首条消息执行 ⇒ load 后再补发一次（首条早到会被丢）。
        frame.addEventListener('load', () => { if (liveWebFrame === frame)
            postSoundToFrame(frame); }, { once: true });
        appendWebFrame(frame, spec.url);
        attachPointerPost(frame);
        postSoundToFrame(frame);
        retrySoundPost(frame);
    }
    function currentViewport() {
        return [Math.max(1, Math.round(window.innerWidth || 0)), Math.max(1, Math.round(window.innerHeight || 0))];
    }
    // 尺寸稳定后按新视口重建（见 WEB_RESIZE_RELOAD_DELAY_MS 处说明）。
    function onWindowResize() {
        if (!webUrl)
            return;
        const [w, h] = currentViewport();
        if (w === viewW && h === viewH)
            return; // 尺寸没变（如仅滚动条/dpr 变化）不重建
        viewW = w;
        viewH = h;
        if (webResizeTimer !== null)
            clearTimeout(webResizeTimer);
        webResizeTimer = setTimeout(reloadWebFrame, WEB_RESIZE_RELOAD_DELAY_MS);
    }
    function reloadWebFrame() {
        webResizeTimer = null;
        const url = webUrl;
        if (!url || !liveWebFrame || !liveWebFrame.isConnected)
            return;
        pendingWebFrame?.remove(); // 上一次预载作废（其 settle 靠 isConnected 判定，见下）
        pendingWebFrame = null;
        const token = frameToken;
        const spec = webFrameSpec(url, window.location, altOrigin);
        const frame = makeWebFrame(spec);
        // 预载期不遮挡旧帧；用 visibility（而非 display）保留布局 ⇒ 壁纸读到的视口尺寸仍正确
        frame.style.visibility = 'hidden';
        let settled = false;
        let timer = null;
        const settle = (ok) => {
            if (settled)
                return;
            settled = true;
            if (timer !== null)
                clearTimeout(timer);
            if (pendingWebFrame === frame)
                pendingWebFrame = null;
            // 期间已切换/清空（token 变）或帧已被移除 ⇒ 丢弃；预载失败则保留旧帧（宁可尺寸不对也不留白）
            if (ok && token === frameToken && webUrl === url && frame.isConnected) {
                fill.replaceChildren(frame);
                liveWebFrame = frame;
                frame.style.visibility = '';
                attachPointerPost(frame); // 指针直传跟着**可见**帧走（预载帧在 hidden 期间不该收坐标）
                postSoundToFrame(frame); // 重建后的新帧同样需要声音设置；shim 可能还没装 ⇒ 重发兜底
                retrySoundPost(frame);
            }
            else {
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
    function markActive() {
        document.body.setAttribute('data-we-wallpaper', 'true');
    }
    function markInactive() {
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
            const result = new Promise((resolve) => {
                let settled = false;
                let timer = null;
                // 成功/失败/超时都要落定一次并清掉定时器（否则测试与生产都留悬挂 timer）。
                const done = (r) => {
                    if (settled)
                        return;
                    settled = true;
                    if (timer !== null)
                        clearTimeout(timer);
                    resolve(r);
                };
                timer = setTimeout(() => done('timeout'), VIDEO_LOAD_TIMEOUT_MS);
                video.addEventListener('loadeddata', () => done('ok'), { once: true });
                video.addEventListener('error', () => done('unsupported'), { once: true });
            });
            video.src = url;
            fill.appendChild(video);
            videoHealth.attach(video);
            if (!videoOpts?.silent)
                applyVideoSound(video);
            if (paused)
                video.pause(); // 暂停态下换壁纸：新视频同样不播
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
            if (!resizeListening) {
                window.addEventListener('resize', onWindowResize);
                resizeListening = true;
            }
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
                if (token !== frameToken)
                    return; // 期间已切换/清空 → 丢弃
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
                if (canvas.width > 0)
                    blurCanvas.width = canvas.width;
                if (canvas.height > 0)
                    blurCanvas.height = canvas.height;
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
            if (currentImage)
                applyKenBurns(currentImage, kenBurnsEnabled && currentImageKenBurnsAllowed);
        },
        setFitMode(mode) {
            fitMode = mode;
            applyFit(currentImage);
            applyFit(currentVideo);
        },
        // 文字颜色跟随壁纸亮度（2026-09-03）：把颜色写为 --wp-chat-fg，
        // styles.ts 消息列文字消费者用它；null/空则移除（回主题默认）。移除时删变量。
        setChatFg(color) {
            if (!color)
                document.documentElement.style.removeProperty('--wp-chat-fg');
            else
                document.documentElement.style.setProperty('--wp-chat-fg', color);
        },
        // 文字描边（2026-10-01）：与文字色同源——按文字色亮度取对立色阴影（亮字深边/暗字亮边），
        // 写在 --wp-chat-outline，由 styles.ts 的贴壁纸文字消费者读取。0 档/空色 = 移除变量，
        // 消费者 fallback 到 none ⇒ 默认观感与加此功能前一致（零回归）。
        setChatOutline(color, level) {
            const shadow = color ? outlineShadow(color, level) : null;
            if (!shadow)
                document.documentElement.style.removeProperty('--wp-chat-outline');
            else
                document.documentElement.style.setProperty('--wp-chat-outline', shadow);
        },
        // 省电：视频壁纸停/续播（web 壁纸在 iframe 内，插件无法控制）。
        setPaused(value) {
            paused = value;
            if (!currentVideo)
                return;
            if (value)
                currentVideo.pause();
            else
                playVideo(currentVideo);
        },
        // 声音总开关（scene 音效在渲染器侧；这里管视频壁纸）：关立即静音、开按宿主策略恢复。
        setSoundEnabled(enabled) {
            soundEnabled = enabled;
            syncWebSound(); // web 壁纸：无条件下发（没有 currentVideo 也要同步）
            if (!currentVideo)
                return;
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
            if (currentVideo)
                currentVideo.volume = volume;
            syncWebSound(); // web 壁纸：音量同样即时下发
        },
        getVideoHealth() {
            return videoHealth.snapshot();
        },
    };
}
