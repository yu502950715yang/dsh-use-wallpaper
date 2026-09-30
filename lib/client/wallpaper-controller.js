import { resolveBackground } from './background-layer.js';
import { measureLuma, lumaToTextColor } from './luma.js';
import { manualTextColor, normalizeMode, normalizeOutlineLevel } from './text-color.js';
// 贴壁纸文字颜色与描边（2026-10-01，用户报告「某些壁纸文字看不清」）：
//   · 手动档（white/black/custom）直接下发固定色，**不测 preview** —— 否则异步测量结果会覆盖手选色；
//   · auto 档沿用 2026-09-03 的 preview 亮度测量（暗壁纸白字 / 亮壁纸黑字）；
//   · 描边档位随文字色一起下发（对立色阴影由 background-layer 按文字色亮度算）。
// 竞态防护：gen 校验（换了壁纸不覆盖）+ 落地前重读模式（期间改手动则不覆盖手选色）。
function createTextStyler(layer, opts, genOf) {
    const measure = opts.measurePreviewLuma ?? measureLuma;
    // 最近一次 auto 测光的结果及其壁纸 id（2026-10-01，用户报告「选自动时描边像不生效」）：
    // 设置变更（改档位/描边）时**同步**复用该结果，用户拖滑杆即时可见，且不必重新测图；
    // 换壁纸时 id 不匹配 ⇒ 不复用（各自重新测光）。
    let autoColor = null;
    let autoColorFor;
    function readStyle() {
        const s = opts.textStyle?.();
        return {
            mode: normalizeMode(s?.mode),
            custom: typeof s?.custom === 'string' ? s.custom : '',
            outline: normalizeOutlineLevel(s?.outline),
        };
    }
    function clear() {
        autoColor = null;
        autoColorFor = undefined;
        layer.setChatFg('');
        layer.setChatOutline('', 0);
    }
    /** forceMeasure：select 展示壁纸时强制重测（新壁纸/重选）；设置变更时用缓存即可。 */
    function apply(info, forceMeasure = false) {
        const { mode, custom, outline } = readStyle();
        const manual = manualTextColor(mode, custom);
        if (manual !== null) {
            autoColor = null;
            autoColorFor = undefined;
            layer.setChatFg(manual);
            layer.setChatOutline(manual, outline);
            return;
        }
        const cached = autoColorFor === info?.id ? autoColor : null;
        if (cached) {
            layer.setChatFg(cached);
            layer.setChatOutline(cached, outline);
            if (!forceMeasure)
                return; // 设置变更：直接用缓存，不再测图（拖动描边零延迟）
        }
        const url = info?.previewUrl;
        if (!url) {
            if (!cached)
                clear();
            return;
        } // 无 preview 可测 → 回主题默认（有缓存则保留）
        const gen = genOf();
        void measure(url).then((luma) => {
            if (gen !== genOf())
                return; // 期间已切换壁纸
            if (readStyle().mode !== 'auto')
                return; // 期间已改成手动档
            if (luma === null) {
                if (!cached)
                    clear();
                return;
            } // 测光失败：有上次结果则保留（不闪）
            const color = lumaToTextColor(luma);
            autoColor = color;
            autoColorFor = info?.id;
            layer.setChatFg(color);
            layer.setChatOutline(color, readStyle().outline); // 用最新档位
        }).catch(() => { if (gen === genOf() && !cached)
            clear(); });
    }
    return { apply, clear };
}
export function createWallpaperController(layer, opts) {
    let list = [];
    // I3：select 竞态防护 —— 每次 select 递增 generation，异步完成后（scene
    // 渲染回调等）校验 generation 未变才应用，防止乱序覆盖最新选择。
    let selectGeneration = 0;
    // 当前展示的壁纸：设置面板改文字颜色/描边后，无需重选壁纸即可重新下发（applyTextStyle）。
    let currentInfo;
    const textStyler = createTextStyler(layer, opts, () => selectGeneration);
    async function load() {
        list = await opts.fetchList();
        return list;
    }
    async function select(id) {
        const gen = ++selectGeneration;
        // Finding 2：壁纸切换/取消时释放当前 scene 渲染器资源（wasm 场景 + 脚本运行时）。
        // 旧渲染器的 raf 循环随 canvas 被替换/移除终止，但其持有的 scene/quickjs 需显式释放。
        opts.sceneRenderer?.dispose?.();
        // 取消壁纸：空 id 直接清空背景层（恢复默认背景，露出 DSH 原生背景）。
        // 同步生效并递增 generation，使进行中的旧选择异步回调被竞态防护丢弃。
        if (id === '') {
            layer.showNone();
            currentInfo = undefined;
            textStyler.clear(); // 清文字颜色与描边，回主题默认
            return;
        }
        // 列表未加载时自动拉取（show() 委托 select 的前提）；加载失败则静默放弃本次选择
        if (list.length === 0) {
            try {
                await load();
            }
            catch {
                return;
            }
        }
        if (gen !== selectGeneration)
            return;
        // I1 修复：controller 缓存的 list 只在为空时刷新（见上方），而设置面板的列表是
        // 独立 fetch 维护的——新添加的壁纸会出现在面板列表却不在 controller 缓存里。
        // 若 list.find(id) 找不到（旧缓存过期），重新拉取一次列表再查找，避免
        // 「列表可见却选不中（无任何反应）」。重试后仍找不到才放弃。
        let info = list.find((w) => w.id === id);
        if (!info) {
            try {
                await load();
            }
            catch {
                return;
            }
            if (gen !== selectGeneration)
                return;
            info = list.find((w) => w.id === id);
            if (!info)
                return;
        }
        const plan = resolveBackground(info);
        switch (plan.kind) {
            case 'video':
                layer.showVideo(plan.url);
                break;
            case 'image':
                layer.showImage(plan.url, plan.kenBurns);
                break;
            case 'web':
                layer.showWeb(plan.url);
                break;
            case 'scene': {
                if (opts.sceneRenderer) {
                    // ⚠️ 只创建**一个** canvas（前景 = 渲染目标）——它就是页面上显示的那个。
                    // 2026-09-10 Task5 修复：此前这里额外 `document.createElement('canvas')` 出 `bg`
                    // 并交给 `showSceneCanvas(fg, bg)`，background-layer 会把它作为 `.wp-scene-blur`
                    // **先** append 进 `.wp-bg-fill`（DOM 序在前）。而**没有任何**存活路径给它设过尺寸
                    // （wasm-renderer 明确「bg 参数忽略」，three-renderer 的 `_bg` 同样忽略）→ 它永远停在
                    // HTML canvas 默认 **300×150**，再被 CSS `.wp-scene-blur{width:100%;height:100%;
                    // transform:scale(1.1)}` 拉伸到全屏。于是 `document.querySelector('canvas')`
                    // （取文档里第一个 canvas = 这个空的 300×150）读到的**不是** three 真正渲染的 canvas，
                    // 真机排查因此被误导成「渲染缓冲没设成视口尺寸 → 画面被放大模糊」。
                    // 现在不再创建这个死 canvas：DOM 里只剩 three 渲染/显示的那一个（尺寸 = 视口×dpr）。
                    const fg = document.createElement('canvas');
                    try {
                        let ok = await opts.sceneRenderer.render(plan.wallpaperId, fg);
                        if (!ok) {
                            // Task 9 语义保留：wasm 失败时 fg 可能已被绑定 WebGPU context → 重建 canvas
                            // 重试一次（组合层对已失败壁纸直接返回 false；2026-08-21 起 JS 渲染已禁用，
                            // 重试仍走 wasm/组合层，最终失败落入下方 preview 回退）
                            const fg2 = document.createElement('canvas');
                            ok = await opts.sceneRenderer.render(plan.wallpaperId, fg2);
                            if (ok) {
                                if (gen !== selectGeneration)
                                    return;
                                layer.showSceneCanvas(fg2);
                                break;
                            }
                        }
                        if (gen !== selectGeneration)
                            return; // 期间已切换 → 丢弃旧渲染结果
                        if (ok) {
                            layer.showSceneCanvas(fg);
                            break;
                        }
                    }
                    catch {
                        if (gen !== selectGeneration)
                            return;
                        // 渲染异常（reject）→ 与失败同等对待，落入回退
                    }
                }
                if (gen !== selectGeneration)
                    return;
                // 渲染不可用/失败 → 回退 preview
                if (info.previewUrl)
                    layer.showImage(info.previewUrl, !info.hasPreviewGif);
                else
                    layer.showNone();
                break;
            }
            case 'none':
                layer.showNone();
                break;
        }
        // 贴壁纸文字颜色与描边：展示壁纸后下发（手动档＝固定色；auto 档＝异步测 preview 亮度）。
        // 此处 forceMeasure=true：换了壁纸（或重选）必须重新测光，不复用上一张的缓存。
        currentInfo = info;
        textStyler.apply(info, true);
    }
    return {
        load,
        select,
        // 设置面板改了文字颜色/描边 → 立即重新下发（不必重选壁纸）。
        applyTextStyle() { textStyler.apply(currentInfo); },
    };
}
