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
export function resolveBuiltinTexture(path) {
    if (!path)
        return null;
    // 兼容带 .tex 后缀的内置路径（'util/noise.tex' 这类 scene.json 写法）
    const p = path.replace(/\.tex$/, '');
    let key;
    if (p === 'util/white')
        key = 'white';
    else if (p === 'util/noise' || p === 'util/clouds_256')
        key = 'noise256';
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
        const rnd = mulberry32(0x51ab3e7d);
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
// T3.2 音频频谱注入：把频谱字节（0-255）归一化为 uniform 浮点（0-1）写入目标数组。
// uniform 长度按 combo RESOLUTION（16/32/64）可与 64 bin 频谱不等长：
//   超出频谱长度 → 越界补零（无分析器时数组保持 binder 初始化的全零，静音不回归）；
//   短于频谱长度 → 只取前 N 个 bin。
export function fillAudioSpectrumUniform(dest, src) {
    for (let i = 0; i < dest.length; i++) {
        dest[i] = i < src.length ? src[i] / 255 : 0;
    }
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
            if (!uniforms['g_Texture0'])
                uniforms['g_Texture0'] = { value: null };
            for (let i = 0; i < pass.textureSlots.length; i++) {
                const slot = `g_Texture${i + 1}`;
                if (!uniforms[slot])
                    uniforms[slot] = { value: null };
            }
            // 分辨率 uniform（vec4）预建：three 上传 vec4 需要 Vector4/数组，binder 给
            // 的默认 0（number）会在探针渲染时 uniform4fv 转换失败误判编译失败；
            // g_TextureNResolution 语义是读端纹理尺寸，update 阶段会按实际纹理覆盖。
            for (let i = 0; i <= Math.max(pass.textureSlots.length, 0); i++) {
                const res = `g_Texture${i}Resolution`;
                uniforms[res] = {
                    value: new THREE.Vector4(this.width, this.height, 1 / Math.max(1, this.width), 1 / Math.max(1, this.height)),
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
            const prevHandler = this.renderer.debug.onShaderError;
            this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
                compileFailed = true;
                // 诊断增强（2026-08-21）：three 的 onShaderError 只通知不传错误详情，
                // 用 gl.getShaderInfoLog 取 GLSL 编译错误（顶点/片元分开），定位具体语法问题。
                const vsInfo = (gl.getShaderInfoLog(vs) || '').trim();
                const fsInfo = (gl.getShaderInfoLog(fs) || '').trim();
                console.warn(`[wallpaper-engine] 效果 pass ${key} shader 编译失败`, vsInfo ? { vertex: vsInfo } : {}, fsInfo ? { fragment: fsInfo } : {});
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
                console.warn('[wallpaper-engine] 效果 pass 编译失败，跳过:', key);
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
        if (!path)
            return null;
        // 内置程序纹理 / 运行时 RT 引用：不 fetch，直接回退（P0-2）
        const builtin = resolveBuiltinTexture(path);
        if (builtin)
            return builtin;
        const key = `${this.id}:${path}`;
        if (this.textures.has(key))
            return this.textures.get(key) ?? null;
        const resolved = resolveTextureSlotPath(path);
        if (!resolved)
            return null;
        const tex = await loadTexTexture(`/wallpapers/scene/${this.id}/asset?name=${encodeURIComponent(resolved)}`);
        if (!tex)
            console.warn('[wallpaper-engine] 纹理槽加载失败，跳过:', path, '→', resolved);
        this.textures.set(key, tex);
        return tex;
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
                    const slot = `g_Texture${j + 1}`;
                    if (material.uniforms[slot])
                        material.uniforms[slot].value = tex;
                    const res = `g_Texture${j + 1}Resolution`;
                    if (material.uniforms[res]) {
                        const { width: w, height: h } = resolveTextureResolution(tex, this.width, this.height);
                        material.uniforms[res].value = new THREE.Vector4(w, h, 1 / Math.max(1, w), 1 / Math.max(1, h));
                    }
                }
                if (material.uniforms['g_Texture0'])
                    material.uniforms['g_Texture0'].value = readTex;
                // g_Texture0Resolution 随输入纹理实际尺寸（three 0.170 RT 纹理自带 image 尺寸；
                // 未解码普通纹理回退 runner 尺寸）。场景级路径（RT 尺寸 == runner 尺寸）零行为变化。
                if (material.uniforms['g_Texture0Resolution']) {
                    const { width: w, height: h } = resolveTextureResolution(readTex, this.width, this.height);
                    material.uniforms['g_Texture0Resolution'].value = new THREE.Vector4(w, h, 1 / Math.max(1, w), 1 / Math.max(1, h));
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
