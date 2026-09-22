// 对象级效果链（ObjectEffectStage）端到端 harness 入口。
//
// ⚠️ 只 import `lib/client/*`（`npm run build` 的生产编译产物），**不 import `src/`**。
// 由 e2e/verify/verify-hidpi-object-rt.mjs 用 esbuild 打包成自包含 bundle（three 等 bare
// specifier 由 esbuild 解析），再由 headless Edge 打开 —— 不依赖 DSH token。
//
// 走的是与生产逐字相同的入口 `createThreeSceneRenderer().render(id, fg)`：
//   scene.json → collectObjectEffectChains（loadFile = /wallpapers/scene/<id>/asset）
//   → resolveObjectRtSize 预算 → loadSceneToThree（隔离对象）
//   → ObjectEffectStage（setWorldSize → setObjectChains）→ player.setObjectEffectStage
//   → RAF 帧循环：renderIsolatedContents → bindOutputs → 主场景 → advance(elapsedSeconds)
//
// 本文件只额外做**只读观测**与**视口钉尺寸**（不改 lib、不改帧序、不改任何 uniform）：
//
//   ① 抓 player / stage 实例：**不钩 `WebGLRenderer.prototype.render`** —— three 的
//      `WebGLRenderer` 把 `render` 作为**实例属性**在构造器内赋值（原型上没有该方法），
//      在原型上打补丁根本钩不到（上一版 harness 的失效点）。改用 `ThreeScenePlayer` 的
//      **类方法**（`setSceneSize` / `resize` / `setObjectEffectStage` /
//      `renderIsolatedContents`，都在原型上）。本 harness 与 `three-renderer.js` 内的
//      `import { ThreeScenePlayer } from './threejs-player.js'` 由 esbuild 解析到**同一个
//      模块实例**，因此补丁对生产路径创建的实例同样生效。
//   ①c **挂载期**隔离 RT 观测：`window.__fxMountedRt`（+ `__fxMountRtSample()`）在
//      `__fxApplyViewport()` **之前**采样，记录 `three-renderer` 挂载期算出的 rtWidth/rtHeight、
//      挂载期视口/预算，以及独立 oracle 的期望值 —— 专门用来抓 3fd6b00 那类「挂载期 RT 用
//      range 当基准」的缺陷（此前被 `onViewportResize` 覆盖而漏检）。
//   ② 暴露 `__fxApplyViewport()`：显式 `player.setSceneSize(sceneW, sceneH)` +
//      `player.resize(VW, VH)` + `stage.onViewportResize(VW*dpr, VH*dpr)`，**不依赖**
//      `window.innerWidth/innerHeight`（headless 下可能不是窗口尺寸 —— 上一版的失效点）。
//   ③ 暴露 `__fxQuads()` / `__fxIsolated()` / `__fxStats()` / `__fxChains()` / `__fxManualFrame()`
//      供脚本观测与（RAF 不可用时的）手动逐帧驱动；另有 F1 性能**相对信号**观测：
//      `__fxFrameTiming()` / `__fxRtMemory()` / `__fxResetFrameStamps()`（帧间隔与每帧 render
//      累计耗时、对象 RT 显存估算）。
//      ⚠️ 观测口径只走**生产公开 API**（`player.isolatedObjects()` / `debugRunners()` /
//      `player.camera` / `player.scene`），不读私有字段、不为观测在生产代码里加导出。
//   ⑤ URL 参数 `wasm=none`：注入返回 null 的假 loader（生产入口 `loadWasm` 的公开注入点），
//      粒子整层跳过 —— 相位比较因此不被 RAF dt 驱动的粒子随机相污染。
//   ④ 页面侧 console 镜像 `window.__fxLogs`（CDP `Runtime.consoleAPICalled` 为主，
//      这里是双保险；上一版页面侧完全没有捕获 —— 上一版的失效点）。
import * as THREE from 'three';
import { createThreeSceneRenderer } from '../../lib/client/three-renderer.js';
import { ThreeScenePlayer } from '../../lib/client/threejs-player.js';
import { ObjectEffectStage } from '../../lib/client/object-effects.js';
import { setSettingsCtx } from '../../lib/client/settings.js';

const q = new URLSearchParams(location.search);

// ════ ★ 临时实验仪器（清晰度归因用；跑完必须还原）════════════════════════════
// 目的：在不改 lib/src 的前提下，把「对象 RT 尺寸 / 采样过滤 / MSAA」当自变量，
// 量出清晰度（Laplacian 均方）随它们的真实变化 —— 这是归因「713→342」的关键自变量。
// URL 参数（全部缺省关闭）：
//   rt=<w>x<h>      强制对象 RT 像素尺寸（同时作用于对象 RT 与效果链 ping-pong RT：
//                   挂载期经 attachIsolated 的 size，且跳过 onViewportResize 重算）
//   mag=nearest     把合成 quad 采样的纹理（对象 RT / 效果输出）改成 NearestFilter
//   rtsamples=<n>   挂载后把对象 RT 的 samples 改成 n 并 dispose（触发按新 samples 重建）
//   rtdump=1        打印 RT 纹理/材质/颜色空间/过滤的运行时事实
const RT_FIX = /^(\d+)x(\d+)$/.exec(q.get('rt') ?? '');
// rtmap=17:1290x720,246:869x319 —— 逐对象强制 RT 尺寸（多对象隔离时用）
const RT_MAP = new Map();
for (const part of (q.get('rtmap') ?? '').split(',')) {
  const m = /^(\d+):(\d+)x(\d+)$/.exec(part.trim());
  if (m) RT_MAP.set(Number(m[1]), [Number(m[2]), Number(m[3])]);
}
const MAG = q.get('mag') ?? '';
const RT_SAMPLES = q.get('rtsamples') ?? '';
const RT_DUMP = q.get('rtdump') === '1';
const id = q.get('id') ?? '';
const VW = Math.max(1, Math.round(Number(q.get('vw') ?? 1280)));
const VH = Math.max(1, Math.round(Number(q.get('vh') ?? 720)));
// `wasm=none`：注入「返回 null 的 wasm loader」= 生产入口里 `loadWasm` 的公开注入点
// （createThreeSceneRenderer({ loadWasm })）。模块为 null ⇒ `CpuParticleSim` 不存在 ⇒
// createParticleSim 为 undefined ⇒ 粒子对象被 loadSceneToThree 整层跳过（与 `--no-particles`
// 的 404 变体等价，但连 wasm 都不加载，相位比较因此**逐帧确定**、不被 RAF dt 驱动的粒子污染）。
const WASM_NONE = q.get('wasm') === 'none';

// ── ★ 应用级 Glow 开关（2026-09-20，Task 6 验收用；只注入设置 ctx，不改任何渲染语义）────────
// Glow 由 `three-renderer` 在**每次 render** 时 `await readClientSettings()` 决定，而它读的是
// `settings.ts` 的**模块级 ctx** ⇒ 开关 Glow 只能经 `setSettingsCtx` 注入（构造参数无效，
// localStorage 更无效 —— 设置只走 ctx.remote.settings.describe()）。默认（不注入）时
// readClientSettings 回退 `DEFAULTS`，即 `glowEnabled = true`。
//
// URL `glow=on|off` 在**创建 renderer 之前**注入 ⇒ 加载即生效。⚠️ 必须走 URL：`Page.navigate`
// 会重置模块态，页内注入的值活不过一次导航（跨页开/关对照只能靠它）。
const GLOW_PARAM = q.get('glow');
const applyGlowCtx = (on) => {
  setSettingsCtx({
    remote: {
      settings: {
        describe: async () => ({
          ok: true,
          value: { namespaces: [{ ns: 'wallpaper-engine', value: { glowEnabled: on } }] },
        }),
      },
    },
  });
  window.__fxGlowSetting = on;
  return 'ok';
};
if (GLOW_PARAM === 'on' || GLOW_PARAM === 'off') applyGlowCtx(GLOW_PARAM === 'on');

// ── ④ 页面侧 console 镜像（含 window.onerror / unhandledrejection）──────────────
window.__fxLogs = [];
for (const lv of ['log', 'info', 'warn', 'error']) {
  const orig = console[lv].bind(console);
  console[lv] = (...args) => {
    try {
      window.__fxLogs.push({
        level: lv,
        text: args
          .map((a) => {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.stack || a.message;
            try { return JSON.stringify(a); } catch { return String(a); }
          })
          .join(' '),
      });
    } catch { /* 镜像失败不影响页面 */ }
    orig(...args);
  };
}
window.addEventListener('error', (e) =>
  window.__fxLogs.push({ level: 'error', text: '[window.onerror] ' + (e.message ?? String(e)) }));
window.addEventListener('unhandledrejection', (e) =>
  window.__fxLogs.push({
    level: 'error',
    text: '[unhandledrejection] ' + ((e.reason && (e.reason.stack || e.reason.message)) || String(e.reason)),
  }));

// ── ④b GL 日志镜像（**只读观测**，task-8 诊断用）─────────────────────────────────
// 动机：lib 的 compile 探针在 `onShaderError` 里只取 `gl.getShaderInfoLog`；**链接期**失败
// （varying 接口不匹配等）的两个 shader info log 是空的 ⇒ 告警里看不到任何原因。
// 这里包一层 GL 原型方法，把非空的 program/shader info log 镜像到 `window.__fxShaderErrors`
// （只记录、不改写返回值，不影响任何渲染行为）。
window.__fxShaderErrors = [];
for (const proto of [window.WebGLRenderingContext?.prototype, window.WebGL2RenderingContext?.prototype]) {
  if (!proto) continue;
  for (const name of ['getProgramInfoLog', 'getShaderInfoLog']) {
    const orig = proto[name];
    if (typeof orig !== 'function' || orig.__fxWrapped) continue;
    const patched = function (...args) {
      const r = orig.apply(this, args);
      try {
        if (typeof r === 'string' && r.trim() && !window.__fxShaderErrors.includes(r)) window.__fxShaderErrors.push(r);
      } catch { /* 观测失败不影响渲染 */ }
      return r;
    };
    patched.__fxWrapped = true;
    proto[name] = patched;
  }
}

// ── ① 抓 player / stage 实例（补丁打在**类方法**上，见文件头说明）───────────────
const proto = ThreeScenePlayer.prototype;
const wrapProto = (name, onCall) => {
  const orig = proto[name];
  if (typeof orig !== 'function') return; // 防御：签名变化时静默不钩（__player 为 undefined 会被脚本报出）
  proto[name] = function (...args) {
    try { onCall(this, ...args); } catch { /* 观测不得影响生产路径 */ }
    return orig.apply(this, args);
  };
};
wrapProto('setSceneSize', (self) => { window.__player = self; });
wrapProto('resize', (self) => { window.__player = self; });
wrapProto('setObjectEffectStage', (self, stage) => { window.__player = self; window.__stage = stage; });
// ★ Glow 装配观测（Task 6）：`setGlowStage(stage|null)` 是生产公开方法，这里只读地记下它收到的
//   对象 ⇒ 可判「关」档是否真的**没有**装配 Glow（不能只看注入的设置值）。
wrapProto('setGlowStage', (self, stage) => { window.__player = self; window.__glowStage = stage ?? null; });

// ★ 临时实验仪器（见文件上方说明）：
// ① rt=<w>x<h>：改写挂载期传入 attachIsolated 的 RT 尺寸（对象 RT），并**关掉**
//    onViewportResize 的重算 —— 否则 __fxApplyViewport() 会按生产公式把它覆盖回 1280×714。
//    这样效果链 ping-pong RT 与对象 RT 保持一致尺寸（mount 里 runner.setChains 用的是
//    view.rtWidth/rtHeight = 本尺寸），pass 仍是 1:1，不引入额外的 pass 级重采样。
if (RT_FIX || RT_MAP.size > 0) {
  wrapProto('attachIsolated', (self, objectId, kind, content, worldW, worldH, size) => {
    const fix = RT_MAP.get(objectId) ?? (RT_FIX ? [Number(RT_FIX[1]), Number(RT_FIX[2])] : null);
    if (fix) { size.width = fix[0]; size.height = fix[1]; }
  });
  ObjectEffectStage.prototype.onViewportResize = function () { /* 实验：冻结 RT 尺寸 */ };
}
// ② mag=nearest：把合成 quad 采样的纹理过滤改成最近邻。若「RT→屏幕」这一步的双线性
//    重采样是损失来源，最近邻会把它换成点采样（清晰度回升 + 出现锯齿）。
const setFilter = (tex) => {
  if (!tex || !MAG) return;
  const f = MAG === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;
  tex.magFilter = f; tex.minFilter = f; tex.generateMipmaps = false; tex.needsUpdate = true;
};
wrapProto('setObjectOutput', (self, id, texture) => { setFilter(texture); });

// ── ①b 帧时间信号（F1，只读观测；不参与判定截图，只在 [4] 性能段使用）──────────
// 帧边界 = `renderIsolatedContents` 调用（帧循环每帧恰好一次，见 threejs-player 的帧体顺序）。
// 「每帧耗时」用**同一 renderer 实例**的 `render()` 累计：three 的 `WebGLRenderer.render` 是
// **实例属性**（原型上没有，见文件头说明），故在首帧懒补丁到实例上；对象 RT 内容渲染、主场景
// 渲染、每条效果 pass 的提交都走它。⚠️ headless Edge 走 SwiftShader（软件光栅化），光栅化在
// `render()` 调用内同步发生 ⇒ 这个累计值包含光栅化时间，**只能作相对信号**。
const REC = { frameStart: [], renderMs: [], renderCalls: [], accum: 0, calls: 0, patched: false };
window.__fxFrameStamps = REC.frameStart;
window.__fxResetFrameStamps = () => {
  REC.frameStart.length = 0; REC.renderMs.length = 0; REC.renderCalls.length = 0;
  return true;
};
const stat = (arr) => {
  const t = arr.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (t.length === 0) return null;
  const q = (p) => t[Math.min(t.length - 1, Math.floor(p * t.length))];
  return {
    n: t.length, median: q(0.5), p95: q(0.95), min: t[0], max: t[t.length - 1],
    mean: t.reduce((a, b) => a + b, 0) / t.length,
  };
};
/** 帧间隔（RAF 节拍）与每帧 `renderer.render` 累计耗时的中位数 / p95。 */
window.__fxFrameTiming = () => {
  const s = REC.frameStart;
  const intervals = [];
  for (let i = 1; i < s.length; i++) intervals.push(s[i] - s[i - 1]);
  return {
    frames: s.length,
    intervalMs: stat(intervals),
    renderMsPerFrame: stat(REC.renderMs),
    renderCallsPerFrame: stat(REC.renderCalls.map((v) => Number(v))),
  };
};
// 对象 RT 显存估算：Σ_隔离对象 (rtW × rtH × 4 字节) ×（1 张对象 RT + 有 runner 时 2 张 ping-pong）。
// runner 的 ping-pong RT 尺寸 = setChains 传入的对象 RT 尺寸（object-effects.mount 同尺寸）。
// 不计 depth 附件、驱动对齐开销与纹理槽贴图。
window.__fxRtMemory = () => {
  const p = window.__player;
  if (!p) return null;
  const runners = new Set(window.__stage ? [...window.__stage.debugRunners().keys()] : []);
  const items = p.isolatedObjects().map((o) => {
    const texBytes = o.rtWidth * o.rtHeight * 4;
    const runner = runners.has(o.id);
    return { id: o.id, rtWidth: o.rtWidth, rtHeight: o.rtHeight, runner, bytes: texBytes * (runner ? 3 : 1) };
  });
  return { items, totalBytes: items.reduce((s, x) => s + x.bytes, 0) };
};
wrapProto('renderIsolatedContents', (self) => {
  window.__player = self;
  window.__fxFrames = (window.__fxFrames ?? 0) + 1;
  // 关闭上一帧的累计（本帧起点即上一帧的终点），再开新的一帧窗口。
  if (REC.frameStart.length > 0) { REC.renderMs.push(REC.accum); REC.renderCalls.push(REC.calls); }
  REC.accum = 0; REC.calls = 0;
  REC.frameStart.push(performance.now());
  if (!REC.patched) {
    REC.patched = true;
    try {
      const r = self.renderer;
      if (r && typeof r.render === 'function') {
        const orig = r.render.bind(r); // 实例方法：必须绑定实例
        r.render = (...args) => {
          const t0 = performance.now();
          const out = orig(...args);
          REC.accum += performance.now() - t0;
          REC.calls++;
          return out;
        };
      }
    } catch { /* 观测失败不影响生产路径 */ }
  }
});

// ★ 临时实验仪器 ③/④：MSAA 覆盖与运行时事实转储
const applySamples = () => {
  if (!RT_SAMPLES) return;
  const p = window.__player;
  if (!p) return;
  for (const e of p.isolatedObjects()) {
    e.rt.samples = Number(RT_SAMPLES);
    e.rt.dispose(); // 强制按新 samples 重建 framebuffer/renderbuffer
  }
};
window.__fxRtDump = () => {
  const p = window.__player;
  if (!p) return null;
  const r = p.renderer;
  const st = window.__stage;
  const tex0 = (x) => (x && x.material && x.material.map) || null;
  return {
    rendererOutputColorSpace: r.outputColorSpace,
    rendererAntialias: r.getContext()?.getContextAttributes?.()?.antialias ?? null,
    webgl2: !!r.capabilities?.isWebGL2,
    maxSamples: (() => { try { return r.getContext().getParameter(r.getContext().MAX_SAMPLES); } catch { return null; } })(),
    multisampledFbo: (() => {
      try {
        const e = p.isolatedObjects()[0];
        const prop = r.properties.get(e.rt);
        return {
          msaaFbo: !!prop.__webglMultisampledFramebuffer,
          fbo: !!prop.__webglFramebuffer,
          samples: e.rt.samples,
        };
      } catch (err) { return { err: String(err) }; }
    })(),
    isolated: p.isolatedObjects().map((e) => {
      const cm = tex0(e.localScene.children[0]);
      const qm = e.quad.material?.map ?? null;
      const uv = e.quad.geometry?.attributes?.uv?.array;
      let uvr = null;
      if (uv) {
        let u0 = 1, u1 = 0, v0 = 1, v1 = 0;
        for (let i = 0; i < uv.length; i += 2) {
          u0 = Math.min(u0, uv[i]); u1 = Math.max(u1, uv[i]);
          v0 = Math.min(v0, uv[i + 1]); v1 = Math.max(v1, uv[i + 1]);
        }
        uvr = [u0, u1, v0, v1];
      }
      return {
        id: e.id,
        rt: [e.rt.width, e.rt.height],
        samples: e.rt.samples,
        depthBuffer: e.rt.depthBuffer,
        stencilBuffer: e.rt.stencilBuffer,
        rtTex: e.rt.texture ? {
          min: e.rt.texture.minFilter, mag: e.rt.texture.magFilter,
          mips: e.rt.texture.generateMipmaps, colorSpace: e.rt.texture.colorSpace,
          wrapS: e.rt.texture.wrapS, wrapT: e.rt.texture.wrapT,
          type: e.rt.texture.type, format: e.rt.texture.format,
        } : null,
        contentMap: cm ? {
          min: cm.minFilter, mag: cm.magFilter, mips: cm.generateMipmaps,
          colorSpace: cm.colorSpace,
          size: [cm.image?.width ?? null, cm.image?.height ?? null],
        } : null,
        quadMap: qm ? {
          min: qm.minFilter, mag: qm.magFilter, mips: qm.generateMipmaps,
          colorSpace: qm.colorSpace,
          size: [qm.image?.width ?? null, qm.image?.height ?? null],
        } : null,
        quadUvRange: uvr,
      };
    }),
    runnerOut: st ? [...st.debugRunners().entries()].map(([k, rr]) => {
      const o = rr.lastOutput();
      return { id: k, size: o ? [o.image?.width ?? null, o.image?.height ?? null] : null };
    }) : [],
  };
};

// ★ 临时实验仪器 ⑤：把对象 RT / 效果链输出的像素读回成 PNG（用于「模糊出现在哪一步」的定界）。
// which='rt'  = 对象 RT 原图；which='out' = 效果链最终输出（runner 的 last 所在 ping-pong RT）。
// 读回语义：readRenderTargetPixels 读的是**已 resolve** 的纹理（MSAA 由 three 负责 blit），
// 行序自下而上 → 翻成 PNG 的 top-down 再交给 node 侧解码（q-sharpness 同口径）。
window.__fxReadRt = (id, which) => {
  const p = window.__player;
  if (!p) return null;
  const e = p.isolatedObjects().find((o) => o.id === id);
  if (!e) return null;
  let rt = e.rt;
  if (which === 'out') {
    const runner = window.__stage?.debugRunners().get(id);
    if (!runner) return null;
    rt = runner.last === runner.rtA?.texture ? runner.rtA : runner.rtB;
    if (!rt) return null;
  }
  const w = rt.width;
  const h = rt.height;
  const buf = new Uint8Array(w * h * 4);
  p.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  ctx.putImageData(img, 0, 0);
  return { w, h, which, png: cv.toDataURL('image/png') };
};

// ★ 临时实验仪器 ⑥：MSAA 是否真的在 headless/SwiftShader 下被创建并 resolve。
// 手法：把一个**斜置**的双色 quad（左半绿、右半红，边界与像素网格不平行）渲染进 samples=0 / 4
// 两张 RT，读回像素，统计边界像素里出现「中间值」（既非纯绿也非纯红）的个数。
//   - MSAA 未生效（被忽略）：边界像素只可能是纯绿/纯红 → 中间值计数 0；
//   - MSAA 生效：边界像素被 4 个子样本平均 → 出现中间值。
window.__fxMsaaProbe = () => {
  const p = window.__player;
  const r = p.renderer;
  const out = {};
  for (const samples of [0, 4]) {
    const rt = new THREE.WebGLRenderTarget(64, 64, { samples, depthBuffer: true });
    const sc = new THREE.Scene();
    const cam = new THREE.OrthographicCamera(-1, 1, -1, 1, -10, 10);
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(1.0, 2.4),
      new THREE.MeshBasicMaterial({ color: 0x00ff00, side: THREE.DoubleSide, depthTest: false }),
    );
    quad.position.set(-0.5, 0, 0);
    quad.rotation.z = 0.26; // 斜边：与像素网格不平行 → 边界像素为部分覆盖
    quad.frustumCulled = false;
    sc.add(quad);
    sc.updateMatrixWorld(true);
    const prevClear = new THREE.Color();
    r.getClearColor(prevClear);
    r.setClearColor(0x000000, 1);
    r.setRenderTarget(rt);
    r.clear(true, true, false);
    r.render(sc, cam);
    const calls = r.info.render.calls;
    r.setRenderTarget(null);
    r.setClearColor(prevClear, 1);
    const buf = new Uint8Array(64 * 64 * 4);
    r.readRenderTargetPixels(rt, 0, 0, 64, 64, buf);
    let mid = 0, green = 0, dark = 0;
    const seen = new Set();
    for (let i = 0; i < buf.length; i += 4) {
      const R = buf[i], G = buf[i + 1];
      seen.add(`${R},${G}`);
      if (R < 8 && G > 247) green++;
      else if (R < 8 && G < 8) dark++;
      else mid++;
    }
    out[`samples${samples}`] = { calls, green, dark, mid, colors: [...seen].slice(0, 12) };
    rt.dispose();
    quad.geometry.dispose();
    quad.material.dispose();
  }
  return out;
};

// ── ①c 挂载期隔离对象 RT 尺寸观测 ─────────────────────────────────────────────
// 口径史（两次修复，都要有回归靶子）：
//   ① 3fd6b00：`three-renderer` 曾用 `range`（= objectCameraRange，**逐轴钳到 4096**）当 RT 分辨率
//      基准 ⇒ 7430×4147 在 1280×720 视口下只拿到 **720×720**，贴回屏幕放大 1.78× ⇒ 实机明显模糊；
//   ② 2026-09-14 清晰度归因（clarity-report.md）：改成 world 后仍用「世界 × dpr 收口到视口 × dpr」，
//      与合成 quad 的**屏上占位**（世界 × 屏幕密度，密度用 cover 视锥宽算）差 0.8%
//      （GTR 实测 RT 1280×714 vs 占位 1290×720）⇒ 合成那一步是比 0.992 的双线性 + 亚纹素相位漂移
//      ⇒ 整层锐度 −52%（Laplacian 713 → 342），且与 dpr、MSAA 都无关。
// 现口径：RT 像素 = |世界尺寸| × 屏幕密度（= 屏上占位像素），等比收口到 4096。
//
// 为什么当时的 e2e 抓不到 ①：本 harness 在 `render()` 之后额外调了一次 `__fxApplyViewport()`
// （见下），其中 `stage.onViewportResize(...)` 会按 stage 自己记录的**未钳制** worldW/worldH
// 重算 RT —— 覆盖了挂载期由 `three-renderer` 算出的错误尺寸。于是 e2e 最终看到的是「正确」尺寸，
// 而真机（从不 resize）一直是错的。故这里保留**挂载期**采样点：在 `render()` 返回、`__player`
// 可用之后、`__fxApplyViewport()` 调用之前立刻读 `player.isolatedObjects()`，冻进 `__fxMountedRt`。
//
// 判定口径是**独立 oracle**：这里本地重实现 screenScalePx + objectRtSize（含自己的 cover 数学），
// **不 import** lib 的任何尺寸函数 —— 断言不得依赖被测实现自身（否则变异即同谋）。
const OBJ_RT_MAX = 4096; // == src/client/object-range.ts 的 OBJECT_RT_MAX
/** cover 视锥宽（与 src 的 coverRange 同一语义，独立重实现）。 */
const coverWidth = (sceneW, sceneH, viewW, viewH) => {
  const sw = Number.isFinite(sceneW) && sceneW > 0 ? sceneW : 1;
  const sh = Number.isFinite(sceneH) && sceneH > 0 ? sceneH : 1;
  const vw = Number.isFinite(viewW) && viewW > 0 ? viewW : 1;
  const vh = Number.isFinite(viewH) && viewH > 0 ? viewH : 1;
  return vw / vh > sw / sh ? sw : sh * (vw / vh);
};
/** 屏幕密度 = 画布缓冲宽 / cover 视锥宽（设备像素 / 世界单位）。 */
const screenScaleOracle = (sceneW, sceneH, viewW, viewH, dpr) => {
  const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return Math.max(1, Math.floor(viewW * ratio)) / coverWidth(sceneW, sceneH, viewW, viewH);
};
/** 现口径 oracle：|world| × 屏幕密度，等比收口 4096。 */
const objRtOracle = (worldW, worldH, screenScale) => {
  const s = Number.isFinite(screenScale) && screenScale > 0 ? screenScale : 1;
  const abs = (v) => (Number.isFinite(v) ? Math.abs(v) : 0);
  const rawW = abs(worldW) * s;
  const rawH = abs(worldH) * s;
  const k = Math.min(1, OBJ_RT_MAX / Math.max(rawW, rawH, 1));
  return { width: Math.max(1, Math.round(rawW * k)), height: Math.max(1, Math.round(rawH * k)) };
};
/** 旧口径（2026-09-14 之前）：min(|world| × dpr, 视口 × dpr, 4096) 等比收口 —— 缺陷复现值。 */
const objRtOldOracle = (worldW, worldH, dpr, budgetW, budgetH) => {
  const scale = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const abs = (v) => (Number.isFinite(v) ? Math.abs(v) : 0);
  const rawW = abs(worldW) * scale;
  const rawH = abs(worldH) * scale;
  const capW = Math.max(1, Math.min(OBJ_RT_MAX, Math.floor(budgetW) || OBJ_RT_MAX));
  const capH = Math.max(1, Math.min(OBJ_RT_MAX, Math.floor(budgetH) || OBJ_RT_MAX));
  const ratios = [1];
  if (rawW > 0) ratios.push(capW / rawW);
  if (rawH > 0) ratios.push(capH / rawH);
  const s = Math.min(...ratios);
  return { width: Math.max(1, Math.round(rawW * s)), height: Math.max(1, Math.round(rawH * s)) };
};
/** 更早的缺陷公式（3fd6b00 之前）：把「逐轴钳到 4096 的相机范围」当作 world。 */
const clamp4096 = (v) => Math.max(1, Math.min(Math.abs(Number.isFinite(v) ? v : 0), OBJ_RT_MAX));

/** 挂载期隔离对象 RT 采样（**只读**，可反复调用；`__fxMountedRt` 是它的一次冻结快照）。
 *  - `expect`      = 现口径 oracle（world, **挂载期** scene/视口/密度）；
 *  - `expectDeclared` = 同一口径但用 harness 声明视口 VW×VH（对照用）；
 *  - `expectOldFormula` = 旧口径（world × dpr 收口到视口 × dpr）—— 一眼看出是否退回旧行为；
 *  - `expectDefectFormula` = 3fd6b00 前的钳 4096 公式。 */
window.__fxMountRtSample = () => {
  const p = window.__player;
  if (!p) return { ok: false, why: '未抓到 player 实例（原型补丁未命中）' };
  const dpr = p.pixelRatio || window.devicePixelRatio || 1;
  const scene = [p.sceneWidth, p.sceneHeight];
  const mountViewport = [p.viewWidth, p.viewHeight]; // 挂载期生产 path 下发的视口（= window.innerWidth/Height）
  const declaredViewport = [VW, VH];
  const mountScale = screenScaleOracle(scene[0], scene[1], mountViewport[0], mountViewport[1], dpr);
  const declaredScale = screenScaleOracle(scene[0], scene[1], declaredViewport[0], declaredViewport[1], dpr);
  const mountBudget = [Math.floor(mountViewport[0] * dpr), Math.floor(mountViewport[1] * dpr)];
  const declaredBudget = [Math.floor(VW * dpr), Math.floor(VH * dpr)];
  const items = p.isolatedObjects().map((e) => {
    const worldW = Math.abs(e.worldW);
    const worldH = Math.abs(e.worldH);
    const expect = objRtOracle(worldW, worldH, mountScale);
    const expectDeclared = objRtOracle(worldW, worldH, declaredScale);
    const expectOld = objRtOldOracle(worldW, worldH, dpr, mountBudget[0], mountBudget[1]);
    const expectOldDeclared = objRtOldOracle(worldW, worldH, dpr, declaredBudget[0], declaredBudget[1]);
    const expectDefect = objRtOldOracle(
      clamp4096(worldW), clamp4096(worldH), dpr, mountBudget[0], mountBudget[1],
    );
    const rt = [e.rtWidth, e.rtHeight];
    return {
      id: e.id, kind: e.kind,
      world: [worldW, worldH],
      rt,
      screenScale: [mountScale, declaredScale],
      expect: [expect.width, expect.height],
      expectDeclared: [expectDeclared.width, expectDeclared.height],
      expectOldFormula: [expectOld.width, expectOld.height],
      expectOldFormulaDeclared: [expectOldDeclared.width, expectOldDeclared.height],
      expectDefectFormula: [expectDefect.width, expectDefect.height],
      match: rt[0] === expect.width && rt[1] === expect.height,
      matchDeclared: rt[0] === expectDeclared.width && rt[1] === expectDeclared.height,
      matchOldFormula: rt[0] === expectOld.width && rt[1] === expectOld.height,
      matchDefectFormula: rt[0] === expectDefect.width && rt[1] === expectDefect.height,
    };
  });
  return {
    ok: true, dpr, scene,
    mountViewport, declaredViewport, mountBudget, declaredBudget,
    mountScale, declaredScale,
    windowInner: [window.innerWidth, window.innerHeight],
    canvasCss: [VW, VH],
    items,
    allMatch: items.every((i) => i.match),
    anyMatchOldFormula: items.some((i) => i.matchOldFormula || i.matchOldFormulaDeclared),
    anyMatchDefectFormula: items.some((i) => i.matchDefectFormula),
  };
};

// ── ② 视口钉尺寸（显式、幂等；不读 window.innerWidth/Height）────────────────────
window.__fxApplyViewport = () => {
  const p = window.__player;
  if (!p) return { ok: false, why: '未抓到 player 实例（原型补丁未命中）' };
  const dpr = p.pixelRatio || 1;
  p.setSceneSize(p.sceneWidth, p.sceneHeight);
  p.resize(VW, VH);
  // 与生产 path（three-renderer 的 onWindowResize）逐字一致：密度取自 player 自己
  // （player 的 state 刚被 resize 更新 ⇒ 与 cover 同源），不在 harness 里另算一份。
  // ⚠️ 兼容 shim：A/B 对照时若 lib 还是旧口径（无 player.screenScalePx，且 onViewportResize
  // 收的是「视口×dpr」两个预算数），退回旧签名，使同一份 harness 能跑新旧两版。
  const hasScale = typeof p.screenScalePx === 'function';
  if (hasScale) window.__stage?.onViewportResize(p.screenScalePx());
  else window.__stage?.onViewportResize(Math.floor(VW * dpr), Math.floor(VH * dpr));
  return {
    ok: true,
    scene: [p.sceneWidth, p.sceneHeight],
    view: [p.viewWidth, p.viewHeight],
    dpr,
    screenScale: hasScale ? p.screenScalePx() : null,
    buffer: [p.canvas.width, p.canvas.height],
    cam: [p.camera.left, p.camera.right, p.camera.bottom, p.camera.top],
  };
};

// ③ 手动逐帧（RAF 不可用时的兜底；`player.render()` 是公开方法，帧序与帧体一致：
//    renderIsolatedContents → bindOutputs → 主场景 → advance）。注意：手动路径**不**调用
//    `update(dt)`，粒子缓冲区不刷新（与 RAF 路径的差别会在脚本里如实打印）。
window.__fxManualFrame = () => {
  const p = window.__player;
  if (!p) return false;
  p.render();
  return true;
};

/** 主场景内所有「平面 quad」的视口像素矩形（世界尺寸 + 世界位置 + 屏幕矩形）。
 *  隔离对象的合成 quad 与普通图层 quad 都是 PlaneGeometry（参数带世界宽高），粒子是
 *  InstancedBufferGeometry（无 parameters）→ 自动跳过。投影用**显式视口 VW/VH**（不用
 *  window.innerWidth/Height），与截图裁剪保持同一坐标系。 */
window.__fxQuads = () => {
  const p = window.__player;
  if (!p) return null;
  const cam = p.camera;
  const out = [];
  const v = new THREE.Vector3();
  p.scene.updateMatrixWorld(true);
  p.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const prm = o.geometry.parameters;
    if (!prm || !(prm.width > 0) || !(prm.height > 0)) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [dx, dy] of [[-prm.width / 2, -prm.height / 2], [prm.width / 2, -prm.height / 2], [-prm.width / 2, prm.height / 2], [prm.width / 2, prm.height / 2]]) {
      v.set(dx, dy, 0);
      o.localToWorld(v);
      v.project(cam);
      const sx = ((v.x + 1) / 2) * VW;
      const sy = ((1 - v.y) / 2) * VH;
      if (sx < x0) x0 = sx;
      if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy;
      if (sy > y1) y1 = sy;
    }
    out.push({
      worldW: prm.width, worldH: prm.height,
      pos: [o.position.x, o.position.y, o.position.z],
      rect: [x0, y0, x1, y1],
      visible: o.visible,
      material: o.material?.type ?? '',
    });
  });
  return out;
};

/** 正交相机实测视锥（判定脚本用它把 scene.json 的世界坐标换算成截图像素）。 */
window.__fxCameraRect = () => {
  const c = window.__player?.camera;
  return c ? { left: c.left, right: c.right, top: c.top, bottom: c.bottom } : null;
};

/** 隔离对象的**生产 API 观测口径**：全部字段来自公开方法 `player.isolatedObjects()`
 *  （id/kind/rtWidth/rtHeight/localCamera/worldW/worldH/quad），不读任何私有字段，
 *  也不为观测在生产代码里加导出。 */
window.__fxIsolated = () => {
  const p = window.__player;
  if (!p) return null;
  return p.isolatedObjects().map((e) => ({
    id: e.id,
    kind: e.kind,
    rt: [e.rtWidth, e.rtHeight],
    rtActual: [e.rt.width, e.rt.height],
    cam: [e.localCamera.left, e.localCamera.right, e.localCamera.bottom, e.localCamera.top],
    world: [e.worldW, e.worldH],
    quadMat: e.quad.material?.type ?? '',
    quadBlending: e.quad.material?.blending ?? null,
    quadBlendSrc: e.quad.material?.blendSrc ?? null,
    quadBlendDst: e.quad.material?.blendDst ?? null,
    contentMat: e.localScene.children[0]?.material?.type ?? '',
    contentBlending: e.localScene.children[0]?.material?.blending ?? null,
  }));
};

window.__fxStats = () => {
  const p = window.__player;
  return {
    frames: window.__fxFrames ?? 0,
    innerW: window.innerWidth, innerH: window.innerHeight,
    canvasAttrW: p?.canvas?.width ?? null, canvasAttrH: p?.canvas?.height ?? null,
    canvasCssW: p?.canvas?.clientWidth ?? null, canvasCssH: p?.canvas?.clientHeight ?? null,
    devicePixelRatio: window.devicePixelRatio,
    view: [VW, VH],
    scene: p ? [p.sceneWidth, p.sceneHeight] : null,
    viewport: p ? [p.viewWidth, p.viewHeight] : null,
    isolated: p ? p.isolatedObjects().length : null,
    stage: !!window.__stage,
  };
};

/** 各隔离对象的效果链是否已产出（EffectRunner.lastOutput() != null）——判定「链真的在跑」
 *  而不是只看帧计数。`debugRunners()` 是 lib 里的公开诊断钩子。 */
window.__fxChains = () => {
  const st = window.__stage;
  if (!st) return null;
  const out = {};
  for (const [k, r] of st.debugRunners()) out[k] = !!r.lastOutput();
  // 兼容 shim：`rtGraphSkips` 是 P2 期的 API，后续任务已从 stage 上移除 —— 直接调用会抛
  // TypeError，被 evalJS 吞成 `{__err}`（调用方只看到 null，等于这条观测整体失效）。
  return { ready: out, rtGraphSkips: typeof st.rtGraphSkips === 'function' ? st.rtGraphSkips() : null };
};

// ── 页面骨架：固定尺寸 canvas，位于文档 (0,0) → 截图裁剪区域 = 画布 CSS 区域 ──────
const canvas = document.createElement('canvas');
canvas.width = VW;
canvas.height = VH;
canvas.style.cssText = `display:block;width:${VW}px;height:${VH}px`;
document.body.appendChild(canvas);

let ok = false;
let err = null;
try {
  // 生产入口（与线上逐字相同的装配路径）；`wasm=none` 时用假 loader 关掉粒子。
  const renderer = WASM_NONE
    ? createThreeSceneRenderer({ loadWasm: async () => null })
    : createThreeSceneRenderer();
  ok = await renderer.render(id, canvas);
  window.__fxRenderer = renderer;
} catch (e) {
  err = String((e && e.stack) || e);
}
// ★ 挂载期快照：必须在 `__fxApplyViewport()` **之前**采样。此刻读到的 rtWidth/rtHeight 就是
//   `three-renderer` 在挂载期算出来的值；`__fxApplyViewport()` → `stage.onViewportResize(...)`
//   随后会用 stage 记录的 world 把它重算/覆盖（这正是 3fd6b00 被掩盖的机制）。
window.__fxMountedRt = window.__fxMountRtSample();
// 渲染完成后立即钉视口（生产路径用的是 window.innerWidth/Height；headless 下不保证等于窗口）
const vp = window.__fxApplyViewport();
// ★ 临时实验仪器：MSAA 覆盖必须在视口钉好之后（RT 尺寸已定），并且在截图之前。
applySamples();
window.__fxReady = {
  id, ok, err,
  viewport: vp,
  mountedRt: window.__fxMountedRt, // 挂载期 RT 快照（采样于 applyViewport 之前，冻结）
  playerCaught: !!window.__player,
  stageCaught: !!window.__stage,
  wasmNone: WASM_NONE,
};
console.log('[harness] ' + JSON.stringify(window.__fxReady));

// ★ 同页切换入口（2026-09-20）：模拟生产 `wallpaper-controller.select` 的核心序列
//   （`sceneRenderer.dispose()` → 换 canvas → `render(id, canvas)`，同一个 renderer 实例）。
//   用途 = 显存泄漏探测：`navigate` 换页会销毁 WebGL 上下文、把泄漏一起回收，只有在**同一页面内**
//   切换才能观测到「dispose 未释放的资源」累积。只新增函数，不改任何既有逻辑（零回归）。
window.__fxSwitch = async (newId) => {
  const r = window.__fxRenderer;
  if (!r) return 'no-renderer';
  try { r.dispose(); } catch (e) { return 'dispose-fail: ' + String(e); }
  // 生产里 `layer.showSceneCanvas()` 会 replaceChildren 掉旧 canvas ⇒ 这里同样移除，避免
  // 旧 canvas 的 drawing buffer 显存污染测量（那不是本探针要测的泄漏）。
  for (const el of Array.from(document.querySelectorAll('canvas'))) el.remove();
  const c = document.createElement('canvas');
  c.className = 'wp-leak-canvas';
  c.width = VW; c.height = VH;
  c.style.cssText = `display:block;width:${VW}px;height:${VH}px`;
  document.body.appendChild(c);
  try {
    const ok = await r.render(newId, c);
    return ok ? 'ok' : 'render-false';
  } catch (e) { return 'render-throw: ' + String((e && e.message) || e); }
};

// ★ 页内 Glow 开关（Task 6 brief Step 1 的参考实现）：注入 ctx 后**同页重渲染一次**
//   （`__fxSwitch(同 id)` 会 dispose → 换 canvas → render ⇒ 让新设置进入装配）。
//   注意：跨页对照**不能**用它（导航会重置模块态），仍须靠 URL `glow=`；这里保留它作页内对照
//   与「设置是否真的进了装配」的自证入口。
window.__fxSetGlow = async (on) => {
  applyGlowCtx(!!on);
  return await window.__fxSwitch(String(id));
};

// ★ Glow 观测（只读）：注入的设置值 + player 实际收到的 stage + stage 自身的公开诊断字段
//   （rtCount / levelSizes / options / glowFailed，见 glow-stage.ts 的「仅供测试观测」）。
window.__fxGlowInfo = () => {
  const st = window.__glowStage ?? null;
  return {
    setting: window.__fxGlowSetting ?? null,   // null = 未注入 ⇒ 页面走 DEFAULTS(glowEnabled=true)
    present: !!st,
    rtCount: st ? st.rtCount : null,
    levelSizes: st ? st.levelSizes : null,
    options: st ? st.options : null,
    glowFailed: st ? st.glowFailed : null,
  };
};

// ★ 可变尺寸 resize 入口（2026-09-20）：验证「同一 WebGL 上下文内重复 setChains/setPlan 是否泄漏」。
//   `ObjectEffectStage.onViewportResize` 只在**算出的对象 RT 尺寸变化**时才重挂链（object-effects.ts:191），
//   而 `EffectRunner.setPlan/setChains` 里的 `this.textures.clear()` **不 dispose 旧纹理** ⇒ 交替两个尺寸是
//   唯一能让该遗漏显形的路径（切换壁纸会新建 WebGL 上下文，上下文级回收把它掩盖了）。
window.__fxResize = (w, h) => {
  const p = window.__player;
  if (!p) return { err: 'no-player' };
  p.resize(w, h);
  const hasScale = typeof p.screenScalePx === 'function';
  if (hasScale) window.__stage?.onViewportResize(p.screenScalePx());
  const iso = p.isolatedObjects?.() ?? [];
  return {
    w, h,
    screenScale: hasScale ? p.screenScalePx() : null,
    iso0: iso.length ? { id: iso[0].id, rtWidth: iso[0].rtWidth, rtHeight: iso[0].rtHeight } : null,
  };
};

// ★ GL 资源计数（2026-09-20）：three `renderer.info.memory` —— 泄漏判定的**主判据**（整数、零噪声）。
//   three 只在 `texture.dispose()` 时 `deallocateTexture` 并让计数 --；**不 dispose 的纹理会让它只增不减**。
//   ⚠️ 组 A/B 每次切换会新建 WebGLRenderer（计数从 0 重来），只有**同一 renderer 内的 resize（组 C）**
//   可跨步比较 —— 这也是选定组 C 作主判据的原因。
window.__fxGlStats = () => {
  const r = window.__player?.renderer;
  if (!r?.info?.memory) return null;
  return {
    textures: r.info.memory.textures,
    geometries: r.info.memory.geometries,
    programs: r.info.programs?.length ?? null,
    calls: r.info.render?.calls ?? null,
  };
};
