import { objectRtSize } from './object-range.js';
import { EffectRunner } from './effect-runner.js';
import { loadTexTexture } from './tex-loader.js';
// 效果纹理槽加载器（**必须与对象 RT 的 v 约定同一套**，2026-09-14）：
//   对象 RT 由 `threejs-player.attachIsolated` 的 **y 镜像局部相机**渲染 ⇒ RT 的 v=0 = 图像**顶部**
//   （= WE 约定：WE/lwe 直接上传 `.tex` 首行，v=0 也是图像顶部）。效果 shader 用 `v_TexCoord.y`
//   当图像空间坐标（flowmap 的带符号位移 / clouds 的旋转滚动 / foliagesway 的摆动方向），
//   所以纹理槽也必须按 WE 约定（不翻行序）加载 —— 否则「条带位置对、方向与斜度反」
//   （Crimson `effects/waterflow`：mask 落在正确的水面区域，但位移的 v 分量整体上下颠倒）。
//   注意：**只翻一侧不解决问题**（两侧同底部约定时位置对而方向反；只翻 mask 会让位置也反），
//   必须两侧一起从「显示约定」迁到「WE 约定」。
// 抽成工厂（纯函数）便于 node 单测断言注入的 rowOrder 真的传到了加载器。
export function weVRowOrderLoader(load = loadTexTexture) {
    return (url, opts) => load(url, { ...opts, rowOrder: 'topDown' });
}
// 线性可执行判定（spec §5.1）：链中每个 pass 都不写具名 RT，且 bind 与 EffectRunner 的
// **固定绑定**完全一致——`g_Texture0` = 上一 pass 输出（readTex），`g_Texture(j+1)` =
// textureSlots[j]（见 effect-runner.ts 的纹理绑定段）。故判据是「`target` 非空 **或** 存在
// 引用了非 `previous`/非空名的 bind」（bind.name 语义见 shader/effect-chain.ts）：
//   - 无 target、bind 为空（如 refraction 的 2 pass）：由 ping-pong 正确实现；
//   - `bind: [{ name: 'previous', index: 0 }]`：与执行器默认行为同义，线性可执行；
//   - 其它任何 bind 都需要 RT 图语义，执行器无法表达：具名 RT（`_rt_*`）无法绑定；空名
//     （sampler2D 槽）无法表达「某个 g_TextureN 来自纹理槽而非上 pass」的任意映射；
//     `previous` 绑到 index≠0 表示「g_Texture1 = 上一 pass 输出」，而执行器把该槽留给纹理槽；
//   - `fbos` 只对具名 RT 有意义：链内没有 target 时它没有消费者，不构成降级理由。
// 具名 RT 图链（blur / blurprecise / godrays / bloom / shine / localcontrast / bokeh_blur）
// 需要 RT 图执行器（P2），当前整条跳过——产品是错画面，不得硬跑。
export function isLinearEffectChain(passes) {
    if (passes.length === 0)
        return false;
    // 与 EffectRunner 的固定绑定一致者才算线性：`g_Texture0` = 上一 pass 输出。
    // 任何其它 bind（具名 RT、空名 sampler 槽、把 previous 绑到 index ≠ 0）都需要 RT 图语义，
    // 由下游整条跳过 + 告警（P2 再做 RT 图执行器）。
    return passes.every((p) => !p.target && p.bind.every((b) => b.name === 'previous' && b.index === 0));
}
export class ObjectEffectStage {
    host;
    entries = new Map();
    skips = new Set();
    wallpaperId;
    /** 屏幕密度（设备像素 / 世界单位）：对象 RT 尺寸的唯一基准，随视口变化（onViewportResize）。 */
    screenScale;
    disposed = false;
    // 串行链（约束 3）：busy = 有 runner 正在 update，queue = 等待中的 update 任务。
    // 空闲时**同步**发起第一项（本帧立即开始推进，不推迟一个微任务——与场景级
    // `void runner.update(...)` 的行为一致；player 的帧序是 render 之后才 advance，
    // 因此此刻切换 RT 不会打扰本帧主场景渲染）；忙时排队，等前一项 settle 后再发起。
    busy = false;
    queue = [];
    /** 去重告警集合（`warnSkip` 之外的通用去重，按 key 只打印一次，防每帧刷屏）。 */
    warned = new Set();
    constructor(host, opts) {
        this.host = host;
        this.wallpaperId = opts.wallpaperId;
        this.screenScale = opts.screenScale;
    }
    /** 当前屏幕密度（设备像素 / 世界单位）；同源下发契约见类头。 */
    scale() {
        const s = this.screenScale;
        return Number.isFinite(s) && s > 0 ? s : 1;
    }
    /** 世界尺寸（场景像素）：resize 时按新预算重算 RT 像素尺寸的唯一来源。
     *  调用顺序契约：three-renderer 先 setWorldSize 再 setObjectChains（后者不覆盖前者）。 */
    setWorldSize(objId, worldW, worldH) {
        if (this.disposed)
            return;
        const entry = this.entries.get(objId);
        if (entry) {
            entry.worldW = worldW;
            entry.worldH = worldH;
            return;
        }
        this.entries.set(objId, { runner: null, chains: [], worldW, worldH });
    }
    /** 挂载某对象的效果链。调用顺序契约：player 先在 loadSceneToThree 内建好隔离条目，
     *  stage 再挂链（Task 5 的接线顺序：setWorldSize → setObjectChains）；找不到隔离条目
     *  说明契约被破坏 → 明确告警一次，绝不静默丢弃，也绝不猜尺寸。 */
    setObjectChains(objId, chains) {
        if (this.disposed)
            return;
        // 逐条链分类：保留线性链，跳过具名 RT 图链（整链，不硬跑——产物是错画面）。
        const usable = [];
        for (const one of chains) {
            if (isLinearEffectChain(one)) {
                usable.push(one);
            }
            else {
                const label = one.find((p) => p.target)?.target ?? one.find((p) => p.bind.length > 0)?.bind[0]?.name ?? '(具名 RT)';
                this.warnSkip(label);
            }
        }
        if (usable.length === 0)
            return;
        const view = this.host.isolatedObjects().find((o) => o.id === objId);
        if (!view) {
            // 调用顺序契约：player 先在 loadSceneToThree 内建好隔离对象，stage 再挂链
            // （Task 5 的接线顺序：setWorldSize → setObjectChains）。走到这里说明契约被破坏——
            // 明确告警一次，绝不静默丢弃，也绝不猜尺寸。
            this.warnOnce(`no-isolated:${objId}`, `对象 ${objId} 尚无隔离条目，效果链未挂载（调用顺序错误）`);
            return;
        }
        this.mount(objId, usable, view.rtWidth, view.rtHeight);
    }
    /** 视口变化：按新的**屏幕密度**重算每个对象的 RT 像素尺寸，并用同一份链重挂（runner 内部 RT 跟随）。
     *  ⚠️ 参数是「设备像素 / 世界单位」这一个标量（object-range.screenScalePx 的返回值），**不是**
     *  视口宽高预算：旧实现传 `视口 × dpr` 当预算，成了「第二处独立预算」——挂载期与 resize 期
     *  各算一遍、输入不同源时任何一次 resize 都会把 RT 打回旧口径（3fd6b00「挂载期 RT 正确、
     *  resize 后被覆盖」这一漏检类的同源地雷）。密度必须由调用方从**主相机同一套 cover 语义**
     *  取得（three-renderer 用 player.screenScalePx()，见其 resize 回调）。
     *  ⚠️ 遍历 `this.entries` 的**所有**条目（不按有无 runner 过滤）：链全被跳过、因而没有 runner
     *  的隔离对象（如具名 RT 图链）同样要随视口重设 RT，否则视口放大后它一直用旧的小 RT（偏糊）、
     *  视口缩小时又一直占着旧的大 RT（超额显存）。 */
    onViewportResize(screenScale) {
        if (this.disposed)
            return;
        this.screenScale = screenScale;
        for (const [id, entry] of this.entries) {
            // 世界尺寸只由 setWorldSize 确定（唯一来源）。**不要**用 view.rtWidth / 密度 反推：
            // player 的 resizeObjectRT 会回写 rtWidth/rtHeight，反推等于把「已被上限收口的 RT」
            // 当世界尺寸，是不可逆的缩小（第一轮收口后永远回不到原尺寸）。
            const size = objectRtSize(entry.worldW, entry.worldH, this.scale());
            const view = this.host.isolatedObjects().find((o) => o.id === id);
            if (!view)
                continue;
            if (view.rtWidth === size.width && view.rtHeight === size.height)
                continue;
            this.host.resizeObjectRT(id, size.width, size.height);
            // 无 runner（链全被跳过，如具名 RT 图链）→ 只重设 RT，不重挂链、不回退输出。
            if (!entry.runner)
                continue;
            entry.runner.setChains(entry.chains, this.wallpaperId, { width: size.width, height: size.height });
            // 重挂后 runner 的 last 被清空、旧 ping-pong RT 已被 dispose，而 quad 仍绑着那张
            // 已释放的纹理（配合 bindOutputs 的「链未就绪不动输出」契约，会在整个纹理槽重载窗口内
            // 采样已 dispose 的纹理 → 静默画错）。显式回退到对象 RT 原图。
            // （view.rtTexture 在 resizeObjectRT 之后仍有效：player 用 rt.setSize 复用同一个
            //  WebGLRenderTarget，其 .texture 不变。）
            this.host.setObjectOutput(id, view.rtTexture);
        }
    }
    /** 主场景渲染之前：链有输出才切合成 quad 的采样源；没有输出（首帧未就绪 / 该对象无 runner）
     *  则**不动输出**——quad 保持采样对象 RT 原图，不黑屏（降级可见，不静默画错）。 */
    bindOutputs() {
        for (const view of this.host.isolatedObjects()) {
            const out = this.entries.get(view.id)?.runner?.lastOutput() ?? null;
            if (out)
                this.host.setObjectOutput(view.id, out);
        }
    }
    /** 主场景渲染之后：串行推进各 runner 的 update（异步，不阻塞本帧；见类头约束 3）。 */
    advance(time) {
        if (this.disposed)
            return;
        for (const view of this.host.isolatedObjects()) {
            const runner = this.entries.get(view.id)?.runner;
            if (!runner)
                continue;
            runner.setAudioSpectrumSource(null); // three 主路径无音频源（spec §5.4），保持全零
            this.enqueue(() => runner.update(time, view.rtTexture));
        }
    }
    /** 被跳过的具名 RT 图链标识（按标识去重），供诊断与测试查询。 */
    rtGraphSkips() {
        return [...this.skips];
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        // 丢弃尚未发起的排队任务：runner 即将被释放，再跑 update 只会碰已释放的 RT/材质。
        this.queue.length = 0;
        for (const entry of this.entries.values())
            entry.runner?.dispose();
        this.entries.clear();
    }
    // ── 测试/诊断钩子（不参与生产路径） ──
    debugRunners() {
        const out = new Map();
        for (const [id, e] of this.entries)
            if (e.runner)
                out.set(id, e.runner);
        return out;
    }
    debugInjectRunner(id, runner) {
        const view = this.host.isolatedObjects().find((o) => o.id === id);
        // 反向从实测 RT 像素推世界尺寸：仅在测试/诊断（entries 里没有 setWorldSize 的记录）时使用。
        this.entries.set(id, {
            runner,
            chains: [],
            worldW: view ? view.rtWidth / this.scale() : 1,
            worldH: view ? view.rtHeight / this.scale() : 1,
        });
    }
    /** 具名 RT 图链降级告警：按标识去重（同一效果被多个对象引用时只告警一次，不刷屏）。 */
    warnSkip(label) {
        if (this.skips.has(label))
            return;
        this.skips.add(label);
        console.warn(`[wallpaper-engine] 效果需要具名 RT（P2 未实现），跳过: ${label}`);
    }
    /** 去重告警（同一 key 只打印一次，防每帧刷屏）。 */
    warnOnce(key, message) {
        if (this.warned.has(key))
            return;
        this.warned.add(key);
        console.warn(`[wallpaper-engine] ${message}`);
    }
    /** 串行队列入队（约束 3 / 2：只调用既有的 update，不在此建材质）。 */
    enqueue(task) {
        if (this.busy) {
            this.queue.push(task);
            return;
        }
        this.busy = true;
        this.runTask(task);
    }
    runTask(task) {
        let result;
        try {
            result = task();
        }
        catch (e) {
            console.warn('[wallpaper-engine] 对象效果链更新失败:', e);
            this.finishTask();
            return;
        }
        // 同步抛出的错误与 rejected promise 一样只告警不中断：单个对象的效果失败
        // 不得拖垮整条串行链（其它对象与后续帧仍要继续推进）。
        Promise.resolve(result)
            .catch((e) => { console.warn('[wallpaper-engine] 对象效果链更新失败:', e); })
            .then(() => { this.finishTask(); });
    }
    finishTask() {
        const next = this.queue.shift();
        if (next) {
            this.runTask(next);
            return;
        }
        this.busy = false;
    }
    mount(objId, chains, rtW, rtH) {
        let entry = this.entries.get(objId);
        if (!entry) {
            // 反向从实测 RT 像素推世界尺寸（仅在 setWorldSize 未先行时兜底）。
            entry = { runner: null, chains, worldW: rtW / this.scale(), worldH: rtH / this.scale() };
            this.entries.set(objId, entry);
        }
        // setWorldSize 可能已先建条目（three-renderer 的顺序是 setWorldSize → setObjectChains），
        // 此时保留其世界尺寸，不被 RT 尺寸/密度反推覆盖。
        entry.chains = chains;
        if (!entry.runner) {
            // 纹理槽按 WE 约定加载（v=0=图像顶部，与对象 RT 的 v 约定同一套，见 weVRowOrderLoader）。
            entry.runner = new EffectRunner(this.host.renderer, rtW, rtH, { load: weVRowOrderLoader() });
        }
        entry.runner.setChains(chains, this.wallpaperId, { width: rtW, height: rtH });
    }
}
