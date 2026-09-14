// src/client/effect-runner.ts
// 效果链执行器：逐 pass 在 ping-pong RT 上执行 WE 后处理 shader。
// WebGL 部分无法在 node 测试，纯逻辑（blending 映射）导出为 blendModeToThree 供单测。
import * as THREE from 'three';
import { loadTexTexture } from './tex-loader.js';
import { isAudioUniform } from './shader/uniform-binder.js';
// 纹理槽路径推导（spec §3.4 / P0-1）：补 materials/ 前缀 + .tex 后缀；
// 内置 util/ 与运行时 _rt_ 引用原样透传（走回退分支，不 fetch）。
// 前缀先判：'materials/x'（带前缀无后缀）只补后缀，避免双重前缀。
export function resolveTextureSlotPath(path) {
    if (!path)
        return null;
    if (path.startsWith('util/') || path.startsWith('_rt_'))
        return path; // 内置/运行时：走回退分支
    const p = path.startsWith('materials/') ? path : 'materials/' + path;
    return p.endsWith('.tex') ? p : p + '.tex';
}
// 效果纹理槽的**引擎侧引用**判定（纯函数，node 可测）：
//   `util/*` —— WE 安装目录里的**真实纹理**（`<weAssetsDir>/assets/materials/util/noise.tex` 263 KB、
//              `util/clouds_256.tex` 200 KB、`util/white.tex` 5.5 KB —— 均已在真机目录实测存在）；
//   `_rt_*`  —— 运行时**具名 RT** 引用，WE 目录内**没有**对应文件（递归列 `<...>/materials/_rt_*` 为空）。
// 两者都不在壁纸 pkg 内，故都不能走 `/wallpapers/scene/<id>/asset`。
export function isBuiltinTexturePath(path) {
    if (!path)
        return false;
    const p = path.replace(/\.tex$/, '');
    return p.startsWith('util/') || p.startsWith('_rt_');
}
// `util/*` 的**真身** URL：复用 host 既有路由 `/wallpapers/particle-texture`
// （`src/host/routes.ts`，基准目录 `<weAssetsDir>/assets/materials`，路由内部自己拼 `name + '.tex'`
// ⇒ 这里的 name **必须去掉 `.tex` 后缀**，否则会找成 `noise.tex.tex`）。
// 该路由是**既有**路由、非本轮新增（host 改动需重启 `dsh web` 才生效，复用可避免这个前置条件）。
// `_rt_*` 返回 null：运行时具名 RT 在 WE 目录里没有文件，不去打必然 404 的请求。
export function builtinTextureUrl(path) {
    if (!path)
        return null;
    const p = path.replace(/\.tex$/, '');
    if (!p.startsWith('util/'))
        return null;
    return `/wallpapers/particle-texture?name=${encodeURIComponent(p)}`;
}
// mulberry32（与 particles.ts 同种子算法），确定性噪声
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
const BUILTIN_CACHE = new Map();
// 兜底程序化噪声的**逐路径种子**：`util/noise` 与 `util/clouds_256` 在 WE 里是**两张不同的纹理**
// （noise.tex 263 KB / clouds_256.tex 200 KB）。此前把两者映射到同一个 key `'noise256'`（同一个实例）
// 是明确的错 —— 共用一张会让语义完全不同的噪声（vhs 的扫描线/失真噪声 vs clouds 的形状噪声）
// 出现同一图案。这里**分 key、分种子**，至少不再是同一实例。
const BUILTIN_NOISE_SEEDS = {
    noise: 0x51ab3e7d, // util/noise
    clouds256: 0x7e1c9a35, // util/clouds_256
};
export function resolveBuiltinTexture(path) {
    if (!path)
        return null;
    // 兼容带 .tex 后缀的内置路径（'util/noise.tex' 这类 scene.json 写法）
    const p = path.replace(/\.tex$/, '');
    let key;
    if (p === 'util/white')
        key = 'white';
    else if (p === 'util/noise')
        key = 'noise'; // 与 clouds_256 分开（WE 里是两张不同纹理）
    else if (p === 'util/clouds_256')
        key = 'clouds256';
    else if (p.startsWith('_rt_'))
        key = 'white'; // 运行时 RT 一期回退白（A6 合成层精化）
    else
        return null;
    const cached = BUILTIN_CACHE.get(key);
    if (cached)
        return cached;
    let tex;
    if (key === 'white') {
        tex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
    }
    else {
        const size = 256;
        const data = new Uint8Array(size * size * 4);
        const rnd = mulberry32(BUILTIN_NOISE_SEEDS[key] ?? 0x51ab3e7d);
        for (let i = 0; i < size * size; i++) {
            const v = Math.round(rnd() * 255);
            data[i * 4] = v;
            data[i * 4 + 1] = v;
            data[i * 4 + 2] = v;
            data[i * 4 + 3] = 255;
        }
        tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    }
    tex.needsUpdate = true;
    BUILTIN_CACHE.set(key, tex);
    return tex;
}
// 效果纹理槽解析：**优先级 ① util/* 真身（host 路由）→ ② 程序化回退 → ③ 壁纸 pkg 内资源**。
//
// 为什么 ① 必须在 ② 之前（根因，2026-09-14 真机反馈 2454403969 赛博朋克2077）：
//   该壁纸只有 1 个铺满场景的对象（obj 13，3440×1440），挂 3 条链，三条的 `g_Texture1` 都是
//   **WE 引擎内置素材**（不在壁纸 pkg 内）：`effects/clouds` ← `util/clouds_256`、
//   `effects/vhs` ← `util/noise`、`effects/waterripple` ← `util/white`。
//   旧顺序「先程序化回退（同步）→ 命中就直接返回」让 `util/noise` 拿到了 `mulberry32` 逐像素独立
//   随机生成的**均匀白噪声**，而 WE 的 `util/noise.tex` 是**结构化噪声**；vhs 正用它调制扫描线/
//   失真（该壁纸 strength=0.31 / artifacts=1.11 / chromatic=0.07 / distortionstrength=0.24）
//   ⇒ 扫描线被逐像素随机数打散成**满屏杂乱条纹**（画面右侧斜向扫描线 + 底部水平条纹）。
//   真身本来就能拿到：host 已有**通用**路由 `/wallpapers/particle-texture?name=util/noise`，
//   客户端只是从来没试过（[`src/host/routes.ts`] 以 `<weAssetsDir>/assets/materials` 为基准读原始
//   `.tex` 字节，client 侧现有 `loadTexTexture` 解码管线可直接消费）。故此处改为「先真身、失败才回退」。
//
// 约定：
//   - **沿用效果槽参数 `alphaPriority: false`**（效果 shader 把 R8/RG88 的通道当**遮罩数值**读：
//     `pulse.frag` 的 `.r`、`shake.frag` 的 `.rg`；粒子语义会把 R8 变成 rgb 恒白、RG88 变成
//     `(r,r,r,g)` ⇒ 遮罩失效 ⇒ 本该局部的效果覆盖全图。见 `tex-loader.convertUnormToRgba`
//     与提交 3031158）；
//   - 结果（**含失败 null**）一律进调用方传入的缓存 Map（键含壁纸 id + 路径）⇒ 同一路径绝不重复
//     请求、也绝不每帧重试；
//   - 真身取不到时回退程序化近似并 `warn` **一次**（失败结果同样进缓存，故每个路径每张壁纸只告警
//     一次，便于诊断「画面与桌面 WE 不同」）；`_rt_*` 本就无真身 ⇒ 不告警（避免每张壁纸刷屏）；
//   - **取不到就回退、绝不白屏**：加载器异常按失败处理，不把异常抛进帧循环。
export async function loadEffectTextureSlot(path, id, cache, load = loadTexTexture, warn = (message) => console.warn(message)) {
    if (!path)
        return null;
    const key = `${id}:${path}`;
    if (cache.has(key))
        return cache.get(key) ?? null; // 命中（含失败 null 缓存）→ 不重复请求
    const tryLoad = async (url) => {
        try {
            return await load(url, { alphaPriority: false });
        }
        catch {
            return null; // 加载器异常 → 按失败处理（回退 / 告警），绝不白屏
        }
    };
    // ① util/*：先取 WE 安装目录里的真身（host 既有路由；`_rt_*` 无真身 → realUrl 为 null）
    const realUrl = builtinTextureUrl(path);
    if (realUrl) {
        const real = await tryLoad(realUrl);
        if (real) {
            cache.set(key, real);
            return real;
        }
    }
    // ② 程序化回退：内置 `util/*` 与运行时 `_rt_*` 的兜底近似（不白屏）
    const builtin = resolveBuiltinTexture(path);
    if (builtin) {
        if (realUrl) {
            warn('[wallpaper-engine] 引擎内置纹理取不到真身，回退程序化近似（画面可能与桌面 WE 不同）: '
                + `${path} ← ${realUrl}`);
        }
        cache.set(key, builtin);
        return builtin;
    }
    // ③ 壁纸 pkg 内的资源：`materials/<path>.tex` → scene asset 路由。
    //    引擎侧引用（`util/*`、`_rt_*`）走到这里说明既无真身、也不在已知回退表内；实测全库
    //    scene.pkg 内**没有**任何 `util/` / `_rt_` 条目（26 个 pkg 扫描 = 0）⇒ 直接缓存 null，
    //    不打必然 404 的请求（槽保持未绑定，不白屏）。
    if (isBuiltinTexturePath(path)) {
        cache.set(key, null);
        return null;
    }
    const resolved = resolveTextureSlotPath(path);
    if (!resolved)
        return null;
    const tex = await tryLoad(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(resolved)}`);
    if (!tex)
        warn(`[wallpaper-engine] 纹理槽加载失败，跳过: ${path} → ${resolved}`);
    cache.set(key, tex);
    return tex;
}
// ===== EffectRunner 执行参数化纯函数（T1.1，node 可测；WebGL 渲染路径无法在 node 跑）=====
// 输入纹理归一：场景 RT → .texture；对象 RT 纹理 / 任意纹理原样透传。
// update 的 input 参数化（Ruling P1-1）：首 pass 的 g_Texture0 即此纹理。
export function resolveInputTexture(input) {
    return input instanceof THREE.WebGLRenderTarget ? input.texture : input;
}
// ping-pong 写端选择：返回上一写端的对端；无上一写端（null，首 pass 读输入纹理，非 runner RT）→ rtA。
// 与旧实现 read === rtB ? rtA : rtB 等价：read 恒为最近写端（或输入纹理，非 rtA/rtB）。
export function pickWriteTarget(previous, rtA, rtB) {
    if (previous === rtA)
        return rtB;
    return rtA; // previous === rtB 或 null → rtA
}
export function resolveTargetSize(current, opts) {
    return {
        width: opts?.width ?? current.width,
        height: opts?.height ?? current.height,
    };
}
// g_TextureNResolution 推导：image 有尺寸用实际尺寸（three 0.170 的 RT 纹理自带 image
// {width,height,depth}，即场景/对象 RT 分辨率）；image 缺失（未解码普通纹理）→ 回退默认。
export function resolveTextureResolution(tex, fallbackW, fallbackH) {
    return {
        width: tex?.image?.width ?? fallbackW,
        height: tex?.image?.height ?? fallbackH,
    };
}
// g_TextureNResolution 的 **vec4 分量**（WE/lwe 约定）：`(mip0.w, mip0.h, header.w, header.h)`。
// ⚠️ 不是 `(w, h, 1/w, 1/h)`：WE 的效果 shader 用 `.z/.x` 缩放纹理 UV，例如 shake.vert 的
//   `v_TexCoord.zw = uv * g_Texture1Resolution.z / g_Texture1Resolution.x`
// 若 .z 填 1/w，则 .z/.x = 1/w² → mask/方向图的 UV 被压成 ~0 → 所有像素采到同一角 ⇒
// 本该只作用于 mask 区域的效果变成**全图等量位移**（真机「整屏晃动」的根因）。
// 纹理经 `textureFromTex` 时把 `[mip0.w, mip0.h, header.w, header.h]` 存进 userData.fxRes；
// 场景/对象 RT 与未带该字段的纹理按 lwe 约定视为 `(w, h, w, h)`。
export function resolveTextureResolution4(tex, fallbackW, fallbackH) {
    const fx = tex?.userData?.fxRes;
    if (Array.isArray(fx) && fx.length === 4 && Number(fx[0]) > 0 && Number(fx[1]) > 0) {
        return { x: Number(fx[0]), y: Number(fx[1]), z: Number(fx[2]), w: Number(fx[3]) };
    }
    const w = tex?.image?.width ?? fallbackW;
    const h = tex?.image?.height ?? fallbackH;
    return { x: w, y: h, z: w, w: h };
}
// T3.2 音频频谱注入：把频谱字节（0-255）归一化为 uniform 浮点（0-1）写入目标数组。
// uniform 长度按 combo RESOLUTION（16/32/64）可与 64 bin 频谱不等长：
//   超出频谱长度 → 越界补零（无分析器时数组保持 binder 初始化的全零，静音不回归）；
//   短于频谱长度 → 只取前 N 个 bin。
export function fillAudioSpectrumUniform(dest, src) {
    for (let i = 0; i < dest.length; i++) {
        dest[i] = i < src.length ? src[i] / 255 : 0;
    }
}
// pass 的可辨识标识（诊断用，纯函数）：`getMaterial` 的 key 只是**链内下标**（`0`/`1`），单看它
// 无法定位是哪个效果；`CompiledEffectPass` 不带文件路径，故用运行时能拿到的线索拼出可读标识——
// 壁纸 id、链内下标、具名 RT / 纹理槽 / 非默认混合模式 / 片元源首个非注释行。
export function describeEffectPass(pass, key, wallpaperId) {
    const bits = [`pass ${key}`];
    if (wallpaperId)
        bits.push(`壁纸 ${wallpaperId}`);
    if (pass.target)
        bits.push(`target=${pass.target}`);
    const slots = pass.textureSlots.filter((s) => !!s);
    if (slots.length > 0)
        bits.push(`纹理槽=[${slots.join(', ')}]`);
    if (pass.blendMode && pass.blendMode !== 'normal')
        bits.push(`blend=${pass.blendMode}`);
    const head = (pass.rawFrag ?? '')
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'));
    if (head)
        bits.push(`片元首行=${head.length > 60 ? head.slice(0, 60) + '…' : head}`);
    return bits.join('，');
}
export class EffectRunner {
    renderer;
    rtA;
    rtB;
    chains = [];
    id = '';
    last = null; // 最近一次 update 的最终输出（帧循环贴屏用）
    materials = new Map(); // key: `${passIndex}`
    scenes = new Map(); // 每 pass 独立场景（含全屏 quad）
    textures = new Map(); // 纹理槽缓存（key: `${id}:${path}`）
    // 编译失败的 pass（key = 链内下标）：探针渲染一旦确认失败就缓存，后续帧直接返回 null 跳过，
    // 不再「每帧重建材质 + 1×1 探针渲染 + 重复告警」（实测一个坏 pass 每帧 2 条 warning 刷屏）。
    // 失败本来就是跳过该 pass（update 里 `continue`），故缓存**不改变执行语义**；setChains
    // （换壁纸 / 重挂链 / resize 重挂）时清空，链变了要重新尝试编译。
    failed = new Set();
    width;
    height;
    // update 串行化：帧循环每帧调用 update，但内部有异步纹理槽加载（await），
    // 并发 update 会交错使用同一 renderer 的 RT/绑定状态 → 画面黑屏/闪烁。
    // inFlight 标记 update 未完成时跳过本帧（last 保持上次输出，下一帧重试）；
    // 换壁纸后 textures 已清空 → 首帧加载完成前输出 input（场景 RT），不黑屏。
    updateInFlight = false;
    // 音频频谱源（T3.2）：freqData 缓冲引用（scene-renderer 每帧刷新后注入）。
    // null = 无分析器 → 音频 uniform 保持 binder 初始化的全零（静音，行为不变）。
    audioSpectrum = null;
    constructor(renderer, width, height) {
        this.renderer = renderer;
        this.width = width;
        this.height = height;
        this.rtA = new THREE.WebGLRenderTarget(width, height);
        this.rtB = new THREE.WebGLRenderTarget(width, height);
    }
    setChains(chains, wallpaperId, opts) {
        this.chains = chains;
        this.id = wallpaperId;
        this.last = null; // 换壁纸避免首帧显示旧纹理
        this.failed.clear(); // 链变了：编译失败缓存作废，重新尝试（换壁纸/重挂链/resize 重挂）
        // 对象级 RT 尺寸：opts 覆盖或保持当前（向后兼容，场景级调用不传 opts 即保持构造尺寸）
        const size = resolveTargetSize({ width: this.width, height: this.height }, opts);
        this.ensureTargets(size.width, size.height);
        this.disposeMaterials();
        this.textures.clear(); // 换壁纸清空纹理缓存（旧壁纸纹理槽 URL 失效）
        // 纹理槽预加载：异步发起（不 await），update 首次执行时若未就绪则 await——
        // 预加载让纹理尽快到位，减少 update 内 await 次数（并发窗口缩小）。
        for (const pass of chains.flat()) {
            for (const path of pass.textureSlots) {
                if (path)
                    void this.resolveTextureSlot(path);
            }
        }
    }
    // 设置音频频谱源（T3.2）：传入频谱缓冲引用（可每帧刷新后重复注入同一引用，
    // update() 渲染前从缓冲读取当前频谱）；null → 恢复全零静音（不回归）。
    setAudioSpectrumSource(source) {
        this.audioSpectrum = source;
    }
    // RT 尺寸对齐：仅当目标尺寸与当前不一致才重建 ping-pong RT（避免 recreate churn）；
    // 重建后同步 this.width/this.height（getMaterial 预建 g_TextureNResolution 默认值跟随对象 RT 尺寸）。
    ensureTargets(w, h) {
        if (this.rtA.width === w && this.rtA.height === h)
            return;
        this.rtA.dispose();
        this.rtB.dispose();
        this.rtA = new THREE.WebGLRenderTarget(w, h);
        this.rtB = new THREE.WebGLRenderTarget(w, h);
        this.width = w;
        this.height = h;
    }
    disposeMaterials() {
        for (const m of this.materials.values())
            m.dispose();
        // 场景内全屏 quad 的 geometry 一并释放
        for (const key of Array.from(this.scenes.keys()))
            this.disposeSceneQuads(key);
        this.materials.clear();
    }
    getMaterial(pass, key) {
        // 已确认编译失败的 pass：直接跳过（语义与下方失败分支一致——返回 null → update 里 continue）。
        // 不做这层缓存时 update 每帧都会重走「建材质 + 探针渲染」，实测一个坏 pass 每帧 2 条 warning。
        if (this.failed.has(key))
            return null;
        const cached = this.materials.get(key);
        if (cached)
            return cached;
        let material = null;
        try {
            const uniforms = {};
            for (const [name, value] of pass.uniforms) {
                uniforms[name] = { value: Array.isArray(value) ? value.slice() : value };
            }
            // 预建纹理槽 uniform（binder 跳过 sampler，纹理绑定是执行器职责，spec §4.3）
            // textures[i] → g_Texture(i)（WE 官方 scenejson.md:22）；g_Texture0 已在上方预建。
            if (!uniforms['g_Texture0'])
                uniforms['g_Texture0'] = { value: null };
            for (let i = 0; i < pass.textureSlots.length; i++) {
                const slot = `g_Texture${i}`;
                if (!uniforms[slot])
                    uniforms[slot] = { value: null };
            }
            // 分辨率 uniform（vec4）预建：three 上传 vec4 需要 Vector4/数组，binder 给
            // 的默认 0（number）会在探针渲染时 uniform4fv 转换失败误判编译失败；
            // g_TextureNResolution 语义是读端纹理尺寸，update 阶段会按实际纹理覆盖。
            for (let i = 0; i <= Math.max(pass.textureSlots.length, 0); i++) {
                const res = `g_Texture${i}Resolution`;
                uniforms[res] = {
                    value: new THREE.Vector4(this.width, this.height, this.width, this.height),
                };
            }
            // 全屏 quad 在 NDC 下直接输出：模型/视图/投影矩阵取单位阵（WE 行主序 mul(v,M)=M*v）。
            // 其他 mat* uniform（g_ModelViewMatrix 等）：binder 对无值 mat 给 0（number），
            // three 探针渲染时 uniformMatrixNfv 转换失败误判编译失败 → 从 shader 源码提取
            // matN 声明，按维度预建单位矩阵数组（mat2=4 / mat3=9 / mat4=16 元素）。
            const matRe = /uniform\s+mat([234])\s+(\w+)/g;
            const matDefs = new Map();
            for (const src of [pass.vertSrc, pass.fragSrc]) {
                for (const m of src.matchAll(matRe))
                    matDefs.set(m[2], Number(m[1]));
            }
            for (const [name, dim] of matDefs) {
                if (uniforms[name] && typeof uniforms[name].value === 'number') {
                    const n = dim * dim;
                    const id = new Array(n).fill(0);
                    for (let i = 0; i < n; i += dim + 1)
                        id[i] = 1; // 单位阵
                    uniforms[name].value = id;
                }
            }
            if (uniforms['g_ModelViewProjectionMatrix']) {
                uniforms['g_ModelViewProjectionMatrix'].value = new THREE.Matrix4();
            }
            material = new THREE.ShaderMaterial({
                vertexShader: pass.vertSrc,
                fragmentShader: pass.fragSrc,
                uniforms,
                transparent: true,
                depthTest: false,
                depthWrite: false,
                blending: blendModeToThree(pass.blendMode),
            });
            // 预编译检测（Critical-2 修复，方案 2）：three 惰性编译且 onShaderError 只在首次
            // 实际渲染触发，因此渲染一次 1×1 探针强制触发；编译失败时 three 跳过绘制不抛异常，
            // 由 onShaderError 探针置位。GLSL1 源码经 three 自动升级（WebGL2），手动编译会误报。
            let compileFailed = false;
            // 编译错误详情（gl.getShaderInfoLog）在 onShaderError 里取，**攒到探针结束后**与可辨识标识
            // 一起打**一条** warning（原先 handler 内直接 console.warn 且传对象 → 日志显示 `Object Object`，
            // 且每帧重试 ⇒ 每帧 2 条刷屏）。
            let vertLog = '';
            let fragLog = '';
            const prevHandler = this.renderer.debug.onShaderError;
            this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
                compileFailed = true;
                // 诊断增强（2026-08-21）：three 的 onShaderError 只通知不传错误详情，
                // 用 gl.getShaderInfoLog 取 GLSL 编译错误（顶点/片元分开），定位具体语法问题。
                vertLog = (gl.getShaderInfoLog(vs) || '').trim();
                fragLog = (gl.getShaderInfoLog(fs) || '').trim();
            };
            const probeRT = new THREE.WebGLRenderTarget(1, 1);
            try {
                this.renderer.setRenderTarget(probeRT);
                this.renderer.render(this.getScene(key, material), SCREEN_CAMERA);
                this.renderer.setRenderTarget(null);
            }
            finally {
                this.renderer.debug.onShaderError = prevHandler;
                probeRT.dispose();
            }
            if (compileFailed) {
                // 失败缓存：本 key 此后再也不重建材质/不再探针渲染（setChains 时清空重试）。
                this.failed.add(key);
                // 告警**按 pass key 去重**（失败已缓存 ⇒ 每个 key 只会走到这里一次），并带上可辨识标识；
                // 错误详情拼成字符串，不再把对象丢进 console（日志里会显示成 `Object Object`）。
                console.warn(`[wallpaper-engine] 效果 pass 编译失败，跳过: ${describeEffectPass(pass, key, this.id)}`
                    + (vertLog ? `\n  vertex: ${vertLog}` : '')
                    + (fragLog ? `\n  fragment: ${fragLog}` : ''));
                material.dispose();
                this.disposeSceneQuads(key); // 清掉刚缓存的 scene（含 quad），避免残留
                return null;
            }
            this.materials.set(key, material);
            return material;
        }
        catch (e) {
            console.warn('[wallpaper-engine] 效果 pass 编译失败，跳过:', key, e);
            material?.dispose(); // 已构造则释放
            this.disposeSceneQuads(key); // 异常路径同样清理 scene 缓存
            return null;
        }
    }
    // 填充本 pass 材质中所有音频频谱 uniform（g_AudioSpectrum*，binder 初始化的 number[]）：
    // 字节 0-255 → 浮点 0-1（fillAudioSpectrumUniform，长度不等时补零/截取）。
    fillAudioUniforms(material, src) {
        for (const [name, u] of Object.entries(material.uniforms)) {
            if (isAudioUniform(name) && Array.isArray(u.value)) {
                fillAudioSpectrumUniform(u.value, src);
            }
        }
    }
    // 释放某 key 对应场景中全屏 quad 的 geometry 并移除场景缓存（编译失败/异常路径共用）
    disposeSceneQuads(key) {
        const scene = this.scenes.get(key);
        if (scene) {
            for (const child of scene.children) {
                if (child instanceof THREE.Mesh)
                    child.geometry.dispose();
            }
        }
        this.scenes.delete(key);
    }
    getScene(key, material) {
        const cached = this.scenes.get(key);
        if (cached)
            return cached;
        const scene = new THREE.Scene();
        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        quad.frustumCulled = false;
        scene.add(quad);
        this.scenes.set(key, scene);
        return scene;
    }
    async resolveTextureSlot(path) {
        // 解析优先级与缓存语义见 loadEffectTextureSlot：`util/*` 先取 WE 真身、失败才回退程序化近似，
        // 结果（含失败 null）走 this.textures 缓存（键含壁纸 id + 路径）⇒ 不重复请求、不每帧重试。
        return loadEffectTextureSlot(path, this.id, this.textures);
    }
    // 串行化 + 输入参数化（Ruling P1-1）：input 可为场景 RT 或对象 RT 的纹理（任意 Texture）。
    // 返回最终输出纹理；链为空或上一帧 update 未完成（纹理槽异步加载中）→ null。
    // 帧循环用 lastOutput() 贴屏，last 保持最近完成输出，无帧间闪烁。
    async update(time, input) {
        if (this.updateInFlight)
            return null;
        this.updateInFlight = true;
        try {
            const flat = this.chains.flat();
            if (flat.length === 0)
                return null;
            // 纹理槽统一预解析（await 集中在此：所有 fetch 完成前不触碰 renderer，
            // 避免与帧循环的场景渲染/贴屏交错 RT 状态）
            const slotTex = new Map();
            for (let i = 0; i < flat.length; i++) {
                const pass = flat[i];
                for (let j = 0; j < pass.textureSlots.length; j++) {
                    const path = pass.textureSlots[j];
                    if (path)
                        slotTex.set(`${i}:${j}`, await this.resolveTextureSlot(path));
                }
            }
            // 输入归一：场景 RT → .texture，对象 RT 纹理 / 任意纹理原样使用；
            // 首 pass 的 g_Texture0 = 输入纹理（对象 RT 分辨率可能与 runner 默认不同）。
            let readTex = resolveInputTexture(input);
            let lastWrite = null; // ping-pong 上一写端（null = 首 pass）
            for (let i = 0; i < flat.length; i++) {
                const pass = flat[i];
                const material = this.getMaterial(pass, `${i}`);
                if (!material)
                    continue; // pass 级跳过：readTex 不变，下一 pass 写端仍为对端（无自读自写）
                // 纹理槽绑定（值已预解析，无 await）
                for (let j = 0; j < pass.textureSlots.length; j++) {
                    const tex = slotTex.get(`${i}:${j}`) ?? null;
                    // textures[j] → g_Texture(j)（WE 官方 scenejson.md:22：textures 依次绑到 g_Texture0/1/…）。
                    // ⚠️ 曾写成 g_Texture(j+1)：所有效果的纹理槽**整体错位一个**，mask / 方向图落到错误的槽
                    // ⇒ shader 采到默认纹理（如 shake 的 flowmask 槽采到白 ⇒ flowMask≈1.0）⇒ 本该只作用于
                    // mask 区域的效果变成**全图**生效（GTR 整屏抖动 / 整屏脉冲的根因）。j=0 的 null 会被
                    // 下方的 g_Texture0 = readTex 覆盖（效果链输入的语义，见 WE scenejson 文档）。
                    const slot = `g_Texture${j}`;
                    if (material.uniforms[slot])
                        material.uniforms[slot].value = tex;
                    const res = `g_Texture${j}Resolution`;
                    if (material.uniforms[res]) {
                        const r4 = resolveTextureResolution4(tex, this.width, this.height);
                        material.uniforms[res].value = new THREE.Vector4(r4.x, r4.y, r4.z, r4.w);
                    }
                }
                if (material.uniforms['g_Texture0'])
                    material.uniforms['g_Texture0'].value = readTex;
                // g_Texture0Resolution 随输入纹理实际尺寸（three 0.170 RT 纹理自带 image 尺寸；
                // 未解码普通纹理回退 runner 尺寸）。场景级路径（RT 尺寸 == runner 尺寸）零行为变化。
                if (material.uniforms['g_Texture0Resolution']) {
                    const r4 = resolveTextureResolution4(readTex, this.width, this.height);
                    material.uniforms['g_Texture0Resolution'].value = new THREE.Vector4(r4.x, r4.y, r4.z, r4.w);
                }
                if (material.uniforms['g_Time'])
                    material.uniforms['g_Time'].value = time;
                // 音频频谱注入（T3.2）：渲染前把频谱字节归一化 0-1 写入 g_AudioSpectrum* 数组；
                // 无频谱源（null）时跳过——数组保持 binder 初始化的全零（静音，行为不变）。
                if (this.audioSpectrum)
                    this.fillAudioUniforms(material, this.audioSpectrum);
                const writeTarget = pickWriteTarget(lastWrite, this.rtA, this.rtB); // 动态写端：上一写端对端
                this.renderer.setRenderTarget(writeTarget);
                this.renderer.render(this.getScene(`${i}`, material), SCREEN_CAMERA);
                readTex = writeTarget.texture;
                lastWrite = writeTarget;
            }
            this.renderer.setRenderTarget(null);
            this.last = readTex; // 同步记录最终输出（帧循环经 lastOutput 贴屏，避免异步竞态）
            return readTex;
        }
        finally {
            this.updateInFlight = false;
        }
    }
    // 帧循环同步读取最近输出：update 未完成时返回 null（调用方回退场景 RT，避免首帧黑屏）
    lastOutput() {
        return this.last;
    }
    dispose() {
        this.disposeMaterials();
        this.rtA.dispose();
        this.rtB.dispose();
        this.textures.clear();
        this.audioSpectrum = null;
    }
}
// 全屏后处理相机：NDC 正交（PlaneGeometry(2,2) 铺满视口）
const SCREEN_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
SCREEN_CAMERA.position.z = 300;
// 材质 json blending → three 混合模式（WE 枚举，spec §3.2；未知回退 normal）
export function blendModeToThree(mode) {
    switch (mode) {
        case 'add': return THREE.AdditiveBlending;
        case 'multiply': return THREE.MultiplyBlending;
        case 'subtract': return THREE.SubtractiveBlending;
        default: return THREE.NormalBlending;
    }
}
