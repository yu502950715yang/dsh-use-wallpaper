// src/client/glow-stage.ts
// 应用级 Glow（全屏后处理）：bright-pass → 三级降采样 box blur → composite 加法回叠。
// 语义来源是 WE 的应用级设置（general.user.postprocessing），不属于任何壁纸字段。
// 设计：docs/superpowers/specs/2026-09-20-app-level-glow-design.md。
// 颜色空间前提：threejs-player 强制 outputColorSpace = LinearSRGBColorSpace 且纹理未标 colorSpace
// ⇒ 全链路字节域恒等，base RT 的值与离线标定 threshold 的域一致；该前提若改变，threshold 须重标定。
import * as THREE from 'three';
import { renderIntoRenderTarget } from './rt-render.js';
/** 离线实验 A 档（最贴桌面）：见 spec §2.2。 */
export const GLOW_DEFAULTS = { threshold: 0.65, strength: 1.0 };
const THRESHOLD_MAX = 0.99; // 不允许 1：bright-pass 的分母是 (1 - t)
const STRENGTH_MAX = 4;
function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}
/** 参数归一：缺省 / NaN / 越界一律收敛到合法区间，绝不把非法值灌进 uniform。 */
export function normalizeGlowOptions(opts) {
    const t = Number(opts?.threshold);
    const s = Number(opts?.strength);
    return {
        threshold: Number.isFinite(t) ? clamp(t, 0, THRESHOLD_MAX) : GLOW_DEFAULTS.threshold,
        strength: Number.isFinite(s) ? clamp(s, 0, STRENGTH_MAX) : GLOW_DEFAULTS.strength,
    };
}
/** 三级降采样 RT 尺寸（L1 = 1/2、L2 = 1/4、L3 = 1/8），逐级取半且不小于 1px。 */
export function glowLevelSizes(width, height) {
    const out = [];
    let w = Math.max(1, Math.floor(width));
    let h = Math.max(1, Math.floor(height));
    for (let i = 0; i < 3; i++) {
        w = Math.max(1, Math.floor(w / 2));
        h = Math.max(1, Math.floor(h / 2));
        out.push({ w, h });
    }
    return out;
}
// ── shader ────────────────────────────────────────────────────────────────────
// 不做颜色空间转换：链路字节域恒等（见文件头前提），直接按纹理值算 luma。
const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
const BRIGHT_FRAG = `
uniform sampler2D tSrc;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb;
  float luma = dot(c, vec3(0.299, 0.587, 0.114));
  float k = max(0.0, luma - uThreshold) / max(1e-6, 1.0 - uThreshold);
  gl_FragColor = vec4(c * k, 1.0);
}
`;
// 固定 9 taps + uniform 步长（GLSL ES 1.00 要求循环边界为常量表达式；半径由 uStep 表达）
const BLUR_FRAG = `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < 9; i++) {
    float o = float(i - 4);
    sum += texture2D(tSrc, vUv + uStep * o).rgb;
  }
  gl_FragColor = vec4(sum / 9.0, 1.0);
}
`;
const COPY_FRAG = `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0);
}
`;
const COMPOSITE_FRAG = `
uniform sampler2D tBase;
uniform sampler2D tL1;
uniform sampler2D tL2;
uniform sampler2D tL3;
uniform float uStrength;
varying vec2 vUv;
void main() {
  vec3 base = texture2D(tBase, vUv).rgb;
  vec3 glow = (texture2D(tL1, vUv).rgb + texture2D(tL2, vUv).rgb + texture2D(tL3, vUv).rgb) / 3.0;
  gl_FragColor = vec4(clamp(base + glow * uStrength, 0.0, 1.0), 1.0);
}
`;
/** 离线实验的 box blur 半径（像素）：L1 / L2 / L3 = 4 / 6 / 8（spec §2.2）。 */
const BLUR_RADII = [4, 6, 8];
function rtOptions() {
    return {
        type: THREE.HalfFloatType, // 浮点 RT：8 位在多次累加后会有 banding
        format: THREE.RGBAFormat,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        wrapS: THREE.ClampToEdgeWrapping, // §5.19：RT 必须 CLAMP
        wrapT: THREE.ClampToEdgeWrapping,
    };
}
export function createGlowStage(width, height, opts) {
    if (!(width > 0) || !(height > 0))
        return null; // 非法视口 ⇒ 调用方回退直渲
    let options = normalizeGlowOptions(opts);
    // quad + 正交相机：所有 pass 都是全屏覆盖写
    const quadScene = new THREE.Scene();
    const quadCamera = new THREE.Camera();
    const geometry = new THREE.PlaneGeometry(2, 2);
    // 泛型写成 Material：同一个 quad 逐 pass 换 material（占位 MeshBasicMaterial 从不参与渲染）
    const placeholderMat = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, placeholderMat);
    quadScene.add(mesh);
    const brightMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BRIGHT_FRAG, uniforms: { tSrc: { value: null }, uThreshold: { value: options.threshold } }, depthTest: false, depthWrite: false });
    const blurMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BLUR_FRAG, uniforms: { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false });
    const copyMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COPY_FRAG, uniforms: { tSrc: { value: null } }, depthTest: false, depthWrite: false });
    const compositeMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: COMPOSITE_FRAG, uniforms: { tBase: { value: null }, tL1: { value: null }, tL2: { value: null }, tL3: { value: null }, uStrength: { value: options.strength } }, depthTest: false, depthWrite: false });
    let baseRT = null;
    let levelRTs = []; // [L1a, L1b, L2a, L2b, L3a, L3b]
    let levelSizes = [];
    let glowFailed = false;
    let disposed = false;
    // three 在 shader 链接失败时只调 renderer.debug.onShaderError（不抛，见 three.module.js LINK_STATUS 分支），
    // 故首帧 apply 期间临时挂钩子：抓到就置 glowFailed；首帧结束摘掉，避免误判其它材质的 shader 失败。
    let hooked = false; // 当前是否挂着
    let hookSpent = false; // 首帧已挂过：glow program 那时就编译完，之后不再挂
    let hookedRenderer = null;
    let prevOnShaderError;
    function installShaderErrorHook(r) {
        if (hooked || hookSpent)
            return;
        hookSpent = true;
        hooked = true;
        hookedRenderer = r;
        const dbg = r.debug;
        if (!dbg)
            return; // renderer 无 debug（mock / 老版本）⇒ 只剩 try/catch 兜底
        prevOnShaderError = dbg.onShaderError;
        dbg.onShaderError = (...args) => {
            glowFailed = true;
            console.warn('[wallpaper-engine] 应用级 Glow 的 shader 编译/链接失败，已降级为直渲');
            try {
                prevOnShaderError?.(...args);
            }
            catch { /* 原钩子抛错不影响降级 */ }
        };
    }
    function removeShaderErrorHook() {
        if (!hooked)
            return;
        const dbg = hookedRenderer ? hookedRenderer.debug : undefined;
        if (dbg)
            dbg.onShaderError = prevOnShaderError;
        hooked = false;
        hookedRenderer = null;
        prevOnShaderError = undefined;
    }
    const rtCount = () => (baseRT ? 1 : 0) + levelRTs.length;
    function buildTargets(w, h) {
        disposeTargets();
        baseRT = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), rtOptions());
        levelSizes = glowLevelSizes(w, h);
        levelRTs = [];
        for (const s of levelSizes) {
            levelRTs.push(new THREE.WebGLRenderTarget(s.w, s.h, rtOptions()));
            levelRTs.push(new THREE.WebGLRenderTarget(s.w, s.h, rtOptions()));
        }
    }
    function disposeTargets() {
        baseRT?.dispose();
        baseRT = null;
        for (const rt of levelRTs)
            rt.dispose();
        levelRTs = [];
    }
    function runPass(r, mat, dst) {
        mesh.material = mat;
        if (dst)
            renderIntoRenderTarget(r, dst, quadScene, quadCamera);
        else {
            r.setRenderTarget(null);
            r.render(quadScene, quadCamera);
        }
    }
    /** 一级：先水平后垂直各一次 9-tap box blur（ping-pong 回写 a）。 */
    function blurLevel(r, idx, a, b) {
        const radius = BLUR_RADII[idx];
        const size = levelSizes[idx];
        blurMat.uniforms.tSrc.value = a.texture;
        blurMat.uniforms.uStep.value.set(radius / 4 / size.w, 0);
        runPass(r, blurMat, b);
        blurMat.uniforms.tSrc.value = b.texture;
        blurMat.uniforms.uStep.value.set(0, radius / 4 / size.h);
        runPass(r, blurMat, a);
    }
    // 10 个 pass，顺序与离线实验的**链式**一致：down → blur → 作为下一级输入（spec §2.2 / 表 §3.4）
    function renderGlow(r, scene, camera) {
        const [l1a, l1b, l2a, l2b, l3a, l3b] = levelRTs;
        // 1) 主场景 → base RT（透明清屏，§5.22）
        renderIntoRenderTarget(r, baseRT, scene, camera);
        // 2) bright-pass（含降采样）：base → L1a
        brightMat.uniforms.tSrc.value = baseRT.texture;
        runPass(r, brightMat, l1a);
        // 3–4) L1 模糊
        blurLevel(r, 0, l1a, l1b);
        // 5) 降采样：**模糊后的** L1a → L2a
        copyMat.uniforms.tSrc.value = l1a.texture;
        runPass(r, copyMat, l2a);
        // 6–7) L2 模糊
        blurLevel(r, 1, l2a, l2b);
        // 8) 降采样：L2a → L3a
        copyMat.uniforms.tSrc.value = l2a.texture;
        runPass(r, copyMat, l3a);
        // 9) L3 模糊（H + V 两个 pass 计入上一步之后）
        blurLevel(r, 2, l3a, l3b);
        // 10) composite：base + 三级等权上采样累加 → canvas
        compositeMat.uniforms.tBase.value = baseRT.texture;
        compositeMat.uniforms.tL1.value = l1a.texture;
        compositeMat.uniforms.tL2.value = l2a.texture;
        compositeMat.uniforms.tL3.value = l3a.texture;
        compositeMat.uniforms.uStrength.value = options.strength;
        runPass(r, compositeMat, null);
    }
    buildTargets(width, height);
    return {
        apply(r, scene, camera) {
            if (disposed)
                return;
            if (glowFailed) {
                r.setRenderTarget(null);
                r.render(scene, camera);
                return;
            }
            installShaderErrorHook(r);
            try {
                renderGlow(r, scene, camera);
            }
            catch (e) {
                // 绝不白屏：一次失败即永久降级为直渲（运行期异常 / pass 失败）
                glowFailed = true;
                console.warn('[wallpaper-engine] 应用级 Glow 失败，已降级为直渲：' + String(e?.message ?? e));
                r.setRenderTarget(null);
                r.render(scene, camera);
            }
            finally {
                removeShaderErrorHook(); // 只盯首帧：之后其它材质（场景效果链）的 shader 失败不算 Glow 的
            }
        },
        resize(w, h) {
            if (disposed)
                return;
            if (!(w > 0) || !(h > 0))
                return; // 与创建期一致：非法尺寸不动 RT 池
            buildTargets(w, h);
        },
        setOptions(o) {
            options = normalizeGlowOptions(o);
            brightMat.uniforms.uThreshold.value = options.threshold;
            compositeMat.uniforms.uStrength.value = options.strength;
        },
        dispose() {
            if (disposed)
                return;
            disposed = true;
            removeShaderErrorHook();
            disposeTargets();
            geometry.dispose();
            placeholderMat.dispose();
            brightMat.dispose();
            blurMat.dispose();
            copyMat.dispose();
            compositeMat.dispose();
        },
        // 仅供测试观测（不参与渲染语义）
        get rtCount() { return rtCount(); },
        get levelSizes() { return levelSizes; },
        get options() { return options; },
        get glowFailed() { return glowFailed; },
    };
}
