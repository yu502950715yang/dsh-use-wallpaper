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
export function createBackgroundLayer(root) {
    root.classList.add('wp-background-layer');
    const fill = document.createElement('div');
    fill.className = 'wp-bg-fill';
    root.appendChild(fill);
    const overlay = document.createElement('div');
    overlay.className = 'wp-bg-overlay';
    root.appendChild(overlay);
    function clear() { fill.replaceChildren(); }
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
            markActive();
        },
        showWeb(url) {
            clear();
            // web 壁纸：sandbox 无 allow-same-origin（opaque origin）→ 网页脚本无法访问宿主 DOM；
            // allow-scripts 保留网页壁纸自身脚本能力（动画/交互逻辑）。
            const frame = document.createElement('iframe');
            frame.src = url;
            frame.className = 'wp-scene-canvas'; // 复用铺满尺寸样式
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.setAttribute('allow', 'autoplay; fullscreen');
            fill.appendChild(frame);
            markActive();
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
    };
}
