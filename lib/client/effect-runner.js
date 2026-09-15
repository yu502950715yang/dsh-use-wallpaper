// src/client/effect-runner.ts
// 效果链执行器：逐 pass 在 ping-pong RT 上执行 WE 后处理 shader。
// WebGL 部分无法在 node 测试，纯逻辑（blending 映射）导出为 blendModeToThree 供单测。
import * as THREE from 'three';
import { loadTexTexture } from './tex-loader.js';
import { isAudioUniform } from './shader/uniform-binder.js';
// 渲染进 RT 必须透明清屏（清屏 alpha=0），否则效果降 alpha 处会变成不透明黑块贴回主场景。
// 根因见 rt-render.ts 与 AGENT.md §5.22。
import { renderIntoRenderTarget } from './rt-render.js';
import { NAMED_RT_LIMIT } from './effect-graph.js';
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
// ===== 空槽纹理（scene.json 未提供的 sampler 槽，按 shader 声明的 mode 兜底）=====
//
// 背景（真机反馈 2454403969 赛博朋克2077）：该壁纸 `effects/clouds` 的 pass 只有
// `textures: [null, "util/clouds_256"]`（长度 2），而 `clouds.frag` 声明了三个 sampler：
//   g_Texture0（链输入）/ g_Texture1（albedo）/ g_Texture2（`"mode":"opacitymask"` 的 mask）。
// ⇒ g_Texture2 这个槽**从未被提供**：不绑任何东西时 three 的兜底是 1×1 全 0（`emptyTexture`），
// 而这个全 0 对 `flowmask` 语义恰好是**满量程位移**（`(0 - 0.498) * 2 = -0.996`），
// 对 mask 语义则无语义（读到 0 才是「遮罩关」）。`mode` 字段本来就是给这个场景用的：
// **空槽绑什么由 mode 决定**。裁定与依据：
//
//   - `mode: "opacitymask"`（不透明度遮罩）→ 空槽 = 全 0（黑）。乘法遮罩读到 0 ⇒
//     `mix(原图, 效果, 0)` = 原图（效果不作用）；half 透明遮罩类写法同理取最保守值。
//     alpha 取 **255**（不是 0）：WE 自己的 `<WE>/assets/materials/util/black.tex` 首像素
//     实测字节 `00 00 00 ff`（R=G=B=0、A=255），而 shake 的 `g_Texture2` 正是以 `util/black`
//     作 `default` ⇒ 空槽取 (0,0,0,255) 与官方素材逐字节一致；实测硬需求是 `.r` 为 0
//     （shader 读 `.r`），alpha 取 255 同时避免「透明黑」在 premultiply/直通路径上的歧义。
//   - `mode: "flowmask"`（方向图）→ 空槽 = 中灰 ⇒ 零位移。WE 的 `<WE>/assets/materials/util/noflow.tex`
//     （shake `g_Texture1` 的 `default`）首像素实测字节 `7f 7f 00 ff` ⇒ **R=G=127**。
//     shake.frag 的零点常量是 0.498，127/255 = 0.498039 是字节值里最接近 0.498 的一个
//     （128/255 = 0.501961 会把「零位移」变成 +0.0078 的残余位移；0（黑）则是 -0.996 的满量程）。
//     故取 (127,127,0,255)：R/G 对齐 `util/noflow`，B=0 也与该文件一致（shader 只读 `.rg`）。
//   - 其它 / 无 mode 的槽：返回 null ⇒ **不改既有行为**（槽保持不预置，交由 update 的既有逻辑）。
//
// 这些是 1×1 常量纹理：模块级缓存并复用（不得每次 getMaterial 新建）。
const EMPTY_SLOT_CACHE = new Map();
export function resolveEmptySlotTexture(mode) {
    if (!mode)
        return null;
    let key;
    let bytes;
    if (mode === 'opacitymask') {
        key = 'opacitymask';
        bytes = [0, 0, 0, 255]; // 全 0（黑）：乘法遮罩读到 0 ⇒ 效果不作用
    }
    else if (mode === 'flowmask') {
        key = 'flowmask';
        bytes = [127, 127, 0, 255]; // 中灰：对齐 `<WE>/materials/util/noflow.tex` 的 127/127/0/255
    }
    else {
        return null; // 无 mode / 未知 mode：不改行为
    }
    const cached = EMPTY_SLOT_CACHE.get(key);
    if (cached)
        return cached;
    // DataTexture：默认 NearestFilter + 不生成 mipmap + unpackAlignment 1，
    // 1×1 下任意 UV 都采到同一 texel（含 REPEAT 槽的越界 UV）。
    const tex = new THREE.DataTexture(new Uint8Array(bytes), 1, 1, THREE.RGBAFormat);
    tex.needsUpdate = true;
    EMPTY_SLOT_CACHE.set(key, tex);
    return tex;
}
// pass 的纹理槽总数：`textures` 数组长度 与 shader 声明的 `g_TextureN` 最大下标 + 1 的较大者。
// 数组长度不够（声明了 sampler 但 scene.json 的 textures 没给到那一位）时必须补齐到声明下标，
// 否则空槽纹理根本无从绑定 —— 这正是 2454403969 的 clouds（数组长 2、声明到 g_Texture2）的情形。
export function effectSlotCount(pass) {
    let count = pass.textureSlots.length;
    // `?? {}`：容忍早于本字段构造的 pass 对象（如既有测试 fixture / 外部调用方），
    // 语义等同「无 mode 标注」⇒ 槽数退回 textures.length（既有行为）。
    for (const name of Object.keys(pass.samplerModes ?? {})) {
        const m = /^g_Texture(\d+)$/.exec(name);
        if (m)
            count = Math.max(count, Number(m[1]) + 1);
    }
    return count;
}
// 单个槽的**预置/兜底**纹理（纯函数，node 可测）：
//   - index 0：`g_Texture0` 是效果链输入，由 update 绑上一 pass 输出（readTex）⇒ 恒 null；
//   - `textures[index]` 已提供（非空）：真纹理是异步加载的，预置阶段留 null，等 update 绑；
//   - 未提供：按 shader 声明的 mode 取空槽常量纹理（无 mode ⇒ null）。
// update 里对**未提供**的槽必须保持这个兜底值（不得被覆盖成 null —— 那会退回 three 的全 0 兜底，
// 对 flowmask 就是满量程位移）。
export function resolveSlotFallback(pass, index) {
    if (index <= 0)
        return null;
    if (pass.textureSlots[index])
        return null;
    return resolveEmptySlotTexture(pass.samplerModes?.[`g_Texture${index}`]);
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
    plan = null;
    // 具名 RT 池：key = `${chainIndex}:${name}`（作用域 = 单条链，见 effect-graph.ts 头注）
    namedRt = new Map();
    // 已告警的 key（壁纸 id + 链序号）：resize 重挂会再次进入 setPlan，去重避免刷屏
    warnedKeys = new Set();
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
    // 效果纹理槽加载器（缺省 `loadTexTexture`；可注入以携带 **v 约定** —— 见构造参数注释）。
    load;
    // `opts.load`：纹理槽加载器（缺省 `loadTexTexture`）。**调用方用它携带纹理 v 约定**：
    //   效果 shader 把 `v_TexCoord.y` 当**图像空间**坐标（flowmap 的带符号位移、clouds 的旋转/滚动、
    //   foliagesway 的摆动方向…），而纹理由对象 RT 提供 —— 二者的 v 约定必须是**同一套**，
    //   否则条带位置对而方向/斜度反（Crimson waterflow 真机「方向对但位置/斜度不对」）。
    //   对象 RT 走 `threejs-player.attachIsolated` 的 y 镜像局部相机（v=0=图像顶部 = WE 约定），
    //   故 `ObjectEffectStage` 注入 `rowOrder:'topDown'` 的 loader 与之对齐；
    //   未注入的调用方（旧场景级路径）保持 `'bottomUp'`，行为与本参数引入前逐字一致。
    constructor(renderer, width, height, opts = {}) {
        this.renderer = renderer;
        this.width = width;
        this.height = height;
        this.load = opts.load ?? loadTexTexture;
        this.rtA = new THREE.WebGLRenderTarget(width, height);
        this.rtB = new THREE.WebGLRenderTarget(width, height);
    }
    /** 挂载带具名 RT 的效果计划。**只允许在加载期 / resize 重挂期调用**（帧内不得建 RT，§5.11）。 */
    setPlan(plan, chains, wallpaperId, opts) {
        this.plan = plan;
        this.chains = chains;
        this.id = wallpaperId;
        this.last = null;
        this.failed.clear();
        const size = resolveTargetSize({ width: this.width, height: this.height }, opts);
        this.ensureTargets(size.width, size.height);
        this.ensureNamedTargets(plan);
        this.disposeMaterials();
        this.textures.clear();
        for (const pass of chains.flat()) {
            for (const path of pass.textureSlots) {
                if (path)
                    void this.resolveTextureSlot(path);
            }
        }
    }
    /** 具名 RT 池：先释放旧的再按计划重建（resize / 换壁纸 / 重挂链共用）。 */
    ensureNamedTargets(plan) {
        this.clearNamedTargets();
        for (const target of plan.namedTargets) {
            this.namedRt.set(target.key, new THREE.WebGLRenderTarget(target.width, target.height));
        }
        for (const chainIndex of plan.droppedChains) {
            this.warnOnce(`${this.id}:${chainIndex}`, `[wallpaper-engine] 效果链 ${chainIndex} 的具名 RT 超过 ${NAMED_RT_LIMIT} 张，整链跳过（壁纸 ${this.id}）`);
        }
    }
    clearNamedTargets() {
        for (const rt of this.namedRt.values())
            rt.dispose();
        this.namedRt.clear();
    }
    /** 按 key 去重的 console.warn（同一条件只报一次，避免每帧 / 每次重挂刷屏）。 */
    warnOnce(key, message) {
        if (this.warnedKeys.has(key))
            return;
        this.warnedKeys.add(key);
        console.warn(message);
    }
    setChains(chains, wallpaperId, opts) {
        this.plan = null; // 旧场景级路径无计划
        this.clearNamedTargets(); // 不残留上一份计划的具名 RT
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
            // 槽数取 effectSlotCount（≥ textures.length）：**声明了 sampler 但 textures 数组没给到**
            // 的槽也要建出来，否则空槽纹理无从绑定（2454403969 的 clouds 就是数组长 2、声明到 g_Texture2）。
            // 未提供的槽按 shader 声明的 mode 预置空槽纹理（opacitymask → 黑、flowmask → 中灰）；
            // 无 mode 的槽预置 null，与既有行为一致。
            if (!uniforms['g_Texture0'])
                uniforms['g_Texture0'] = { value: null };
            const slotCount = effectSlotCount(pass);
            for (let i = 0; i < slotCount; i++) {
                const slot = `g_Texture${i}`;
                if (!uniforms[slot])
                    uniforms[slot] = { value: resolveSlotFallback(pass, i) };
            }
            // 分辨率 uniform（vec4）预建：three 上传 vec4 需要 Vector4/数组，binder 给
            // 的默认 0（number）会在探针渲染时 uniform4fv 转换失败误判编译失败；
            // g_TextureNResolution 语义是读端纹理尺寸，update 阶段会按实际纹理覆盖。
            // 同样铺到 slotCount：空槽（1×1 常量）也要有维度正确的预置值，避免 .z/.x 出现 0/0。
            for (let i = 0; i <= Math.max(slotCount, 0); i++) {
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
                // 探针只用来触发编译，像素不被读取；走同一个 RT 渲染入口以保持清屏语义一致。
                renderIntoRenderTarget(this.renderer, probeRT, this.getScene(key, material), SCREEN_CAMERA);
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
    /** 绑一个槽：纹理 + g_TextureNResolution（vec4 口径见 AGENT.md §5.17）。 */
    bindSlot(material, slot, tex) {
        const name = `g_Texture${slot}`;
        // bind 的槽可能超出 getMaterial 预建的声明槽数：缺席就补建，绑定不得静默丢失。
        if (!material.uniforms[name])
            material.uniforms[name] = { value: null };
        material.uniforms[name].value = tex;
        const res = material.uniforms[`g_Texture${slot}Resolution`];
        if (res) {
            const r4 = resolveTextureResolution4(tex, this.width, this.height);
            res.value = new THREE.Vector4(r4.x, r4.y, r4.z, r4.w);
        }
    }
    /** 无计划（setChains 旧路径）时的退化计划：全部按线性 ping-pong。 */
    plannedPasses() {
        if (this.plan)
            return this.plan.passes;
        return this.chains.flatMap((chain, chainIndex) => chain.map((p, passIndex) => ({
            chainIndex,
            passIndex,
            bindings: [],
            write: { type: 'pingpong' },
            blendMode: p.blendMode,
        })));
    }
    /** `textures` 槽引用的 `_rt_*` 是否为本链**未声明**的全局运行时 RT（如 _rt_FullFrameBuffer）。
     *  调用方还需排除「该槽已被 bind 覆盖」：那时实际用的是 bind 的源，拦截与告警都是误导。 */
    isForeignRuntimeRt(path, chainIndex) {
        return path.startsWith('_rt_') && !this.namedRt.has(`${chainIndex}:${path}`); // 池 key = `${链序号}:${名字}`
    }
    async resolveTextureSlot(path) {
        // 解析优先级与缓存语义见 loadEffectTextureSlot：`util/*` 先取 WE 真身、失败才回退程序化近似，
        // 结果（含失败 null）走 this.textures 缓存（键含壁纸 id + 路径）⇒ 不重复请求、不每帧重试。
        // `this.load` 携带调用方的纹理 v 约定（缺省 loadTexTexture = 显示约定；见构造函数注释）。
        return loadEffectTextureSlot(path, this.id, this.textures, this.load);
    }
    // 串行化 + 输入参数化（Ruling P1-1）：input 可为场景 RT 或对象 RT 的纹理（任意 Texture）。
    // 返回最终输出纹理；链为空或上一帧 update 未完成（纹理槽异步加载中）→ null。
    // 帧循环用 lastOutput() 贴屏，last 保持最近完成输出，无帧间闪烁。
    // 有 plan 时按计划执行：写端三态（具名 RT / ping-pong）+ bind 按 g_Texture<index> 覆盖槽；
    // `previous` = 进入 target 序列前的输入（lwe CImage::configurePassTarget），逐链独立。
    async update(time, input) {
        if (this.updateInFlight)
            return null;
        this.updateInFlight = true;
        try {
            const flat = this.chains.flat();
            if (flat.length === 0)
                return null;
            const planned = this.plannedPasses();
            if (planned.length === 0)
                return null;
            // 纹理槽统一预解析（await 集中在此；key 用链内下标，不用平坦下标——droppedChains 会错位）
            const slotTex = new Map();
            for (const pp of planned) {
                const p = this.chains[pp.chainIndex][pp.passIndex];
                const slots = effectSlotCount(p);
                for (let j = 0; j < slots; j++) {
                    const path = p.textureSlots[j];
                    const key = `${pp.chainIndex}:${pp.passIndex}:${j}`;
                    // 该槽被本 pass 的 bind 覆盖时实际用的是 bind 的源（真实库 _rt_imageLayerComposite_*_a/_b
                    // 共 6 处均如此）⇒ 不拦截、不告警，否则是误导性告警。
                    const boundByBind = pp.bindings.some((b) => b.slot === j);
                    if (path && !boundByBind && this.isForeignRuntimeRt(path, pp.chainIndex)) {
                        // `_rt_*` 不在本链具名 RT 表内 = 全局运行时 RT：解析只会拿到 1×1 白纹（凭空造内容），
                        // 故保持该槽默认（通常为 null），只告警一次。
                        this.warnOnce(`foreign-rt-slot:${this.id}:${key}:${path}`, `[wallpaper-engine] 纹理槽引用了本链未声明的运行时 RT，跳过绑定（槽留空）: `
                            + `g_Texture${j} ← ${path}（壁纸 ${this.id}，pass ${pp.chainIndex}:${pp.passIndex}）`);
                        slotTex.set(key, resolveSlotFallback(p, j));
                        continue;
                    }
                    slotTex.set(key, path ? await this.resolveTextureSlot(path) : resolveSlotFallback(p, j));
                }
            }
            let readTex = resolveInputTexture(input);
            let lastWrite = null;
            let last = null;
            // previous = 进入 target 序列前的输入（lwe CImage::configurePassTarget），逐链独立
            let inSeq = false;
            let effectInput = null;
            let currentChain = -1;
            for (const pp of planned) {
                const p = this.chains[pp.chainIndex][pp.passIndex];
                const key = `${pp.chainIndex}:${pp.passIndex}`;
                if (pp.chainIndex !== currentChain) {
                    inSeq = false;
                    effectInput = null;
                    currentChain = pp.chainIndex;
                }
                // bind 里未解析的名字（不在本链具名 RT 表内）：该槽保持默认，按 key 去重告警
                for (const name of pp.unresolvedBinds ?? []) {
                    if (!name)
                        continue; // 空名 bind 无语义：不刷噪声
                    this.warnOnce(`unresolved-bind:${this.id}:${pp.chainIndex}:${pp.passIndex}:${name}`, `[wallpaper-engine] bind 引用的名字不在本链内，该槽保持默认: ${name}`
                        + `（壁纸 ${this.id}，pass ${pp.chainIndex}:${pp.passIndex}）`);
                }
                const writesNamed = pp.write.type === 'named';
                const material = this.getMaterial(p, key);
                if (!material) {
                    // 写具名 RT 的 pass 失败 ⇒ 派生读端会读到空 RT，整条计划放弃（spec §6）
                    if (writesNamed) {
                        this.renderer.setRenderTarget(null);
                        this.last = null;
                        return null;
                    }
                    continue; // ping-pong pass 失败：读端不变，继续（P1 既有语义）
                }
                if (writesNamed && !inSeq) {
                    inSeq = true;
                    effectInput = readTex;
                }
                // 默认槽绑定（slot 0 = 当前内容提供者；其余按 textures/空槽兜底）
                // ⚠️ 空槽常量纹理不得被压成 null：全 0 对 flowmask 是满量程位移（见 resolveSlotFallback）
                for (let j = 0; j < effectSlotCount(p); j++) {
                    this.bindSlot(material, j, slotTex.get(`${pp.chainIndex}:${pp.passIndex}:${j}`) ?? null);
                }
                this.bindSlot(material, 0, readTex);
                // bind 覆盖项（优先级最高）
                for (const b of pp.bindings) {
                    const tex = b.source.type === 'previous'
                        ? effectInput
                        : this.namedRt.get(b.source.key)?.texture ?? null;
                    if (tex)
                        this.bindSlot(material, b.slot, tex);
                }
                if (material.uniforms['g_Time'])
                    material.uniforms['g_Time'].value = time;
                if (this.audioSpectrum)
                    this.fillAudioUniforms(material, this.audioSpectrum);
                let writeTarget;
                if (pp.write.type === 'named') {
                    const namedTarget = this.namedRt.get(pp.write.key);
                    if (!namedTarget) {
                        // 计划与池不一致（不应发生）：放弃整条计划，而不是写到错误目标
                        this.warnOnce(`no-named-rt:${this.id}:${key}`, `具名 RT 缺失（${key}），放弃该效果链（壁纸 ${this.id}）`);
                        this.renderer.setRenderTarget(null);
                        this.last = null;
                        return null;
                    }
                    writeTarget = namedTarget;
                }
                else {
                    writeTarget = pickWriteTarget(lastWrite, this.rtA, this.rtB);
                    lastWrite = writeTarget;
                }
                renderIntoRenderTarget(this.renderer, writeTarget, this.getScene(key, material), SCREEN_CAMERA); // 透明清屏见 rt-render.ts
                readTex = writeTarget.texture;
                last = readTex;
                if (!writesNamed && inSeq) {
                    inSeq = false;
                    effectInput = null;
                }
            }
            this.renderer.setRenderTarget(null);
            this.last = last;
            return last;
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
        this.clearNamedTargets();
        this.plan = null; // 计划与具名 RT 一并作废，避免 plannedPasses() 误判为有计划分支
        this.textures.clear();
        this.audioSpectrum = null;
    }
}
// 全屏后处理相机：NDC 正交（PlaneGeometry(2,2) 铺满视口）
const SCREEN_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
SCREEN_CAMERA.position.z = 300;
// 材质 json blending → three 混合模式（对齐 WE `CPass::setupRenderFramebuffer`：
// normal/未知 = `glBlendFunc(ONE, ZERO)` **覆盖**，translucent = SRC_ALPHA/ONE_MINUS_SRC_ALPHA，
// additive = SRC_ALPHA/ONE）。**normal 不能映射成 NormalBlending**：pass 写 ping-pong RT 时会被
// 乘一次 alpha、每过一 pass 再乘一次，半透明图层的 rgb 会逐级趋零（GTR 云消失，见 AGENT.md §5.25）。
export function blendModeToThree(mode) {
    switch (mode) {
        case 'add':
        case 'additive': return THREE.AdditiveBlending;
        case 'multiply': return THREE.MultiplyBlending;
        case 'subtract': return THREE.SubtractiveBlending;
        case 'translucent':
        case 'alpha': return THREE.NormalBlending;
        default: return THREE.NoBlending;
    }
}
