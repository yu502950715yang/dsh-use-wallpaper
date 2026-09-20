export function resolveBackground(info) {
    // scene 与 unknown（project.json 无 type 字段但含 scene.pkg）都按场景渲染
    if ((info.type === 'scene' || info.type === 'unknown') && info.hasScene) {
        return { kind: 'scene', wallpaperId: info.id };
    }
    if (info.type === 'video' && info.file) {
        return { kind: 'video', url: `/wallpapers/media/${info.id}/file` };
    }
    // web 壁纸：iframe 加载网页（index.html 及相对资源经 /wallpapers/web 静态服务）
    if (info.type === 'web') {
        return { kind: 'web', url: `/wallpapers/web/${info.id}/index.html` };
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
// 另一主机名可达 → 壁纸与宿主跨源，故可保留 allow-same-origin（沙箱其余限制仍在，且拿不到 GUI DOM）；
// 不可达 → 退回同源 + 纯 allow-scripts：隔离优先，WebGL 类壁纸降级（空白）。
export function webFrameSpec(wallpaperPath, loc, altOrigin) {
    const origin = altOrigin ?? `${loc.protocol}//${loc.hostname}${loc.port ? ':' + loc.port : ''}`;
    return { url: origin + wallpaperPath, sandbox: altOrigin ? 'allow-scripts allow-same-origin' : 'allow-scripts' };
}
export function createBackgroundLayer(root) {
    root.classList.add('wp-background-layer');
    const fill = document.createElement('div');
    fill.className = 'wp-bg-fill';
    root.appendChild(fill);
    const overlay = document.createElement('div');
    overlay.className = 'wp-bg-overlay';
    root.appendChild(overlay);
    // frameToken：每次背景变更递增，作废尚未落地的 web iframe（另一主机名的探活是异步的）
    let frameToken = 0;
    let altOriginProbe = null;
    // 省电状态与当前视频元素（setPaused 对后者 pause/play）。
    let paused = false;
    let currentVideo = null;
    function clear() { frameToken += 1; fill.replaceChildren(); currentVideo = null; }
    // 探活：另一主机名上同一路径能取到即视为可达。no-cors 读不到响应体（跨源），
    // 故只有网络层失败才 reject —— 401/404 也算「该主机名可达」。
    function probeAlternateOrigin(altOrigin, wallpaperPath) {
        if (typeof fetch !== 'function')
            return Promise.resolve(null);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 1000);
        return fetch(altOrigin + wallpaperPath, { mode: 'no-cors', signal: ac.signal })
            .then(() => altOrigin, () => null)
            .finally(() => clearTimeout(timer));
    }
    function attachWebFrame(spec) {
        const frame = document.createElement('iframe');
        frame.src = spec.url;
        frame.className = 'wp-scene-canvas'; // 复用铺满尺寸样式
        frame.setAttribute('sandbox', spec.sandbox);
        frame.setAttribute('allow', 'autoplay; fullscreen');
        // 壁纸是背景、永不滚动：壁纸文档自身溢出时滚动条会吃掉视口（Firefox 实测 17px×2），
        // 其 100vw / innerWidth 尺寸又会因此反撑出另一条（AGENT.md §5.30）。
        frame.setAttribute('scrolling', 'no');
        fill.appendChild(frame);
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
            applyKenBurns(img, kenBurns);
            fill.appendChild(img);
            markActive();
        },
        showVideo(url) {
            clear();
            const video = document.createElement('video');
            video.src = url;
            video.autoplay = true;
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            fill.appendChild(video);
            currentVideo = video;
            if (paused)
                video.pause(); // 暂停态下换壁纸：新视频同样不播
            markActive();
        },
        showWeb(url) {
            // 旧背景留到新 iframe 就绪再清，避免探活期间白屏
            const token = ++frameToken;
            markActive();
            const loc = window.location;
            const alt = alternateLoopbackOrigin(loc);
            if (!alt) {
                fill.replaceChildren();
                attachWebFrame(webFrameSpec(url, loc, null));
                return;
            }
            altOriginProbe ??= probeAlternateOrigin(alt, url);
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
        // 文字颜色跟随壁纸亮度（2026-09-03）：把颜色写为 --wp-chat-fg，
        // styles.ts 消息列文字消费者用它；null/空则移除（回主题默认）。移除时删变量。
        setChatFg(color) {
            if (!color)
                document.documentElement.style.removeProperty('--wp-chat-fg');
            else
                document.documentElement.style.setProperty('--wp-chat-fg', color);
        },
        // 省电：视频壁纸停/续播（web 壁纸在 iframe 内，插件无法控制）。
        setPaused(value) {
            paused = value;
            if (!currentVideo)
                return;
            if (value)
                currentVideo.pause();
            else
                void currentVideo.play().catch(() => { });
        },
    };
}
