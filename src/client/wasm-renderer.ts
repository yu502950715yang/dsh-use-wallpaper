// Rust/WebGPU 渲染器胶水：实现 wallpaper-controller 的 sceneRenderer 接口。
// 无 WebGPU / wasm 加载失败 → 渲染返回 false，controller 走现有 JS 渲染 / preview 回退链。
import { parseSceneJson } from './scene-json.js';
import { resolveTexPath, shouldUseObjectPath, objectCameraRange, particleWorldSize, particleObjectRange } from './scene-renderer.js';
import { applyAlignment } from './alignment.js';
import { resolveVisibility } from './visibility.js';
import { SceneScriptRuntime } from './scene-script.js';
import { resolveEffectChain } from './shader/effect-chain.js';
import { glslToNagaPass, glslToNagaGlsl, interStageLocationsMatch } from './shader/glsl-to-naga.js';
import type { SceneDescription } from '../shared/types.js';

// Task 2.1 遗留：效果链检测（纯函数）。⚠️ 已无拦截作用——2026-08-21 决策「强制 wasm，
// 禁用 JS 回退」后 wasm 渲染器**不再**用本函数在绑定 WebGPU 前返回 false：所有 scene 壁纸
// 一律走 wasm（对象级效果链由 wasm/对象路径执行，见 set_object_effect /
// set_particle_object_effect；真实 WE shader 经 spv_to_wgsl 编译）。本函数仅保留
// 供测试/外部识别「壁纸是否带对象级 effects」（任一对象 effects 非空 → true），
// 不再参与渲染路径决策。wasm-renderer 渲染循环用 shouldUseObjectPath(obj) 做对象级
// 效果路径调度（与 scene-renderer 语义一致）。
export function hasEffectChains(desc: SceneDescription): boolean {
  // SceneTextObject 无 effects 字段（T3.1：text 对象不走效果路径），先窄化访问
  return desc.objects.some((o) => {
    const effects = (o as { effects?: unknown }).effects;
    return Array.isArray(effects) && effects.length > 0;
  });
}

// uniform 值 → 打包为 f32 数组（wasm UniformBinding.value: Vec<f32>）。sampler(null)/未知 → null
// （不进 uniform 缓冲；采样纹理由 wasm collect_bindings 按 WGSL 声明绑定）。
function flattenUniformValue(value: unknown): number[] | null {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value) && value.every((v) => typeof v === 'number')) return value as number[];
  return null;
}

/// 对象级效果链的 chain_desc（task-8 编译链集成）：解析对象 effects → resolveEffectChain →
/// glslToNagaPass（WE GLSL→桌面 GLSL→@webgpu/glslang→SPIR-V bytes）→ 序列化为 UTF-8 JSON 的
/// `Uint8Array`（wasm-bindgen `Vec<u8>`↔`Uint8Array`）。wasm 侧解析为 `Vec<EffectPassDesc>` 走
/// spv_to_wgsl 编译。任何一步失败（效果链解析失败 / glslang 编译失败 / 无 pass）→ 返回**空**
/// `Uint8Array`。⚠️ 调用方行为（task-15）：空 chain_desc = 编译失败/无有效 pass → 对象**不走
/// 对象级效果链**（不调 set_object_effect / set_particle_object_effect），保持共享路径渲染**原始
/// 内容**（无效果），绝不回退演示渐变覆盖内容（wasm 侧 demo_object_effect_passes 亦改为返回空 Vec）。
async function buildEffectChainDesc(id: string, effects: unknown[]): Promise<Uint8Array> {
  try {
    // 与 scene-renderer 同构的 loadFile：从场景 asset 路由拉取（effect.json / shader / material）。
    const loadFile = async (name: string): Promise<Uint8Array | null> => {
      const resp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(name)}`);
      return resp.ok ? new Uint8Array(await resp.arrayBuffer()) : null;
    };
    interface WireUniform {
      name: string;
      value: number[];
      // std140 block 布局描述（非不透明 uniform 有；sampler 被滤除不进本列表）。
      offset: number;  // 字节 offset（block 内）
      size: number;    // 字节 size
      type: string;    // GLSL 类型（float/vec3/mat4/float[16]）
      binding: number; // 所属 std140 block 的 layout(binding=B)
    }
    // ── MVM（g_ModelViewProjectionMatrix）说明 ──────────────────────────────
    // WE 效果链 vertex shader（如 composelayer.vert）的
    //   `layout(std140, binding=B) uniform Params { mat4 g_ModelViewProjectionMatrix; }`
    // 是**引擎内建 uniform**：scene.json/material json 不给值（不是材质 pass 的 uniform），
    // 故 `spv.uniforms` 里该条的 value 为缺省 → flattenUniformValue 返回 null → 被滤除出
    // std140 block → wasm `pack_std140_block` 该 mat4 落默认全 0。
    // ⚠️ 影响：依赖 MVM 把顶点投影到正确位置的 effect（顶点位移/过屏等）在 wasm 下会算错
    // 位置（乘 0 → 顶点塌到原点/错误坐标）。**执行器需按对象/场景提供正确的 MVM 投影矩阵**
    // （对象级路径：对象局部正交投影 + 中心 origin；场景级：场景正交投影），目前 wasm 侧未
    // 提供，属已知边界。当前库内依赖 MVM 的效果（如 godrays 的 composelayer 层）为 **frag
    // 效果 + vert passthrough**（gl_Position 由 a_TexCoord 直接推导，不乘 MVM），故不受影响；
    // 仅 vert 阶段真正用到 MVM 的效果链才受影响。
    interface WirePass {
      vert_spv: number[];
      frag_spv: number[];
      uniforms: WireUniform[];
      texture_slots: (string | null)[];
      blend_mode: string;
    }
    const passes: WirePass[] = [];
    for (const fx of effects) {
      if (typeof (fx as { file?: unknown } | null)?.file !== 'string') continue;
      const chain = await resolveEffectChain(
        fx as { file: string; passes?: unknown[] },
        loadFile,
      );
      if (!chain) continue;
      for (const p of chain) {
        // task-18：WebGPU inter-stage 匹配校验 + per-pass 容错。WE 效果 shader 偶有 fragment 输入
        // 无对应 vertex 输出（如 waterripple.frag 的 `varying vec2 v_Scroll` 而其 vert 未输出），
        // 此类 pass 在 wasm `EffectChain::new` 建管线时因 "component count ... is different" 校验
        // 失败；若整链视为失败会**回退到演示渐变**（旧行为）。这里改为：inter-stage 不匹配或
        // 单 pass 编译失败 → **跳过该 pass**（效果链级容错），其余 pass 正常组装 → 链创建成功，
        // 效果链真正工作（非渐变、非白屏）。全部 pass 均失败 → passes 为空 → 对象回退原始内容。
        try {
          // task-19（Orange 等场景壁纸残缺根因）REVISED（task-22）：WE 效果链 vertex 若用引擎内建
          // `g_ModelViewProjectionMatrix`（MVM）投影顶点（如 waterwaves/waterripple/waterflow/shake
          // /godrays_combine 的 `gl_Position = mul(vec4(a_Position,1.0), g_ModelViewProjectionMatrix)`），
          // wasm 执行器此前不提供 MVM → `pack_std140_block` 该 mat4 落全 0 → 顶点塌原点 → 效果链输出
          // 透明 → 对象内容消失（task-19 根因，当时改为跳过 MVM pass —— 也误杀了仅**声明** MVM 而
          // gl_Position 用 passthrough 的 cast，导致 godrays 只剩余 gaussian → 静态，task-22 根因）。
          // 现在 wasm `EffectChain` 对 MVM 成员打包 **identity 矩阵**（对象级 quad 顶点已是 NDC
          // [-1,1]，正确 MVM 即 identity，对齐 JS `new Matrix4()`），依赖 MVM 的 pass 顶点不变形塌陷、
          // 正确渲染。故此处**不再跳过 MVM pass**（cast/downsample2/combine/waterwaves 等全部放开，
          // wasm 侧 render 顶点正确）。配合 task-22 的多纹理绑定（combine 的 g_Texture1=previous 绑
          // 原始内容），godrays 光斑/射线/cast 结合完整生效。
          const naga = glslToNagaGlsl(p);
          if (!interStageLocationsMatch(naga.vertGlsl, naga.fragGlsl)) {
            console.warn(`[wasm] 效果链 pass 跳过：inter-stage varying 不匹配（frag 输入缺 vertex 输出）`);
            continue;
          }
          const spv = await glslToNagaPass(p);
          // sampler uniform（value=null）不进 std140 block 列表；仅非 sampler uniform 带
          // offset/size/type/binding 传给 wasm（wasm 按同一 std140 布局 pack，见 EffectChain）。
          // g_Time 也在 block 内，由 wasm 按 name=="g_Time" 每帧写对应 offset（不再固定偏移 0）。
          const uniforms = spv.uniforms
            .map((u): WireUniform | null => {
              const value = flattenUniformValue(u.value);
              return value === null ? null : { name: u.name, value, offset: u.offset ?? 0, size: u.size ?? 0, type: u.type, binding: u.binding };
            })
            .filter((u): u is WireUniform => u !== null);
          passes.push({
            vert_spv: Array.from(spv.vertSpv),
            frag_spv: Array.from(spv.fragSpv),
            uniforms,
            // texture_slots：scene.json passes[i].textures 的槽位（第 i 项 = g_Texture(i+1)）。
            // glsl-to-naga 已按此解析（pass.textureSlots = 路径数组，如 [null,"masks/xxx",null]）。
            // 此前硬编码 [] → wasm build_bind_group 把非首纹理槽全绑 input_view（用背景自身当
            // 遮罩/噪声 → Orange 贴图错乱、godrays 下降采样被背景污染）。透传给 wasm 使其能按
            // 槽位区分 previous(空) 与独立纹理(非空)，消除错绑回归。
            texture_slots: spv.textureSlots.map((ts) => (typeof ts === 'string' && ts.length > 0 ? ts : null)),
            blend_mode: spv.blendMode,
          });
        } catch (e) {
          console.warn(`[wasm] 效果链 pass 跳过（编译失败）：${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (passes.length === 0) {
      console.warn(`[wasm] buildEffectChainDesc(${id}): 无有效 pass（效果链解析失败/无 pass）→ 对象显示原始内容（无效果链）`);
      return new Uint8Array(0);
    }
    return new TextEncoder().encode(JSON.stringify(passes));
  } catch (e) {
    console.warn(`[wasm] buildEffectChainDesc(${id}): 编译失败→ 对象显示原始内容（无效果链）：${e instanceof Error ? e.message : String(e)}`);
    return new Uint8Array(0);
  }
}

// wasm 侧 WeScene 实例的接口（对齐 wasm/pkg/we_scene_wasm.d.ts）
export interface WasmScene {
  resize(w: number, h: number): void;
  load_scene(json: string): void;
  // 2026-08-21 铺满全屏改造：前景也调用 set_cover —— cover 相机 + 场景 clearcolor 清屏
  // （不透明），对齐桌面版默认 FillMode::ASPECTCROP（铺满、不变形、超出方向裁剪）。
  set_cover(): void;
  // T4.3：color/alpha/brightness 为对象调制输入（Float32Array，空 = 缺省 → 无调制，
  // 向后兼容；color 0-255 r g b，alpha 0-1，brightness 乘法系数）。
  load_image(assetId: number, tex: Uint8Array, origin: Float32Array, scale: Float32Array, size: Float32Array, color: Float32Array, alpha: Float32Array, brightness: Float32Array): void;
  // T5：脚本状态灌回——每帧更新图片对象状态（origin/scale/alpha/brightness）。Option 语义：
  // undefined/null = 保持现状；assetId = 对象数组索引（与 load_image 一致）。
  update_image(assetId: number, origin?: Float32Array, scale?: Float32Array, alpha?: number, brightness?: number): void;
  add_particle(json: string, origin: Float32Array, scale: Float32Array, texBytes: Uint8Array): void;
  // M4/Task6：带 effects 的粒子对象走对象路径（粒子内容→对象RT→效果链→合成quad）。
  // chainDesc 语义同 set_object_effect（真实 WE shader 的 SPIR-V bytes JSON；task-15 起空/失败
  // = 不调用本方法，对象走共享路径 add_particle 显示原始内容，绝不用演示 pass 兜底）。
  set_particle_object_effect(objId: number, json: string, origin: Float32Array, scale: Float32Array, texBytes: Uint8Array, worldSize: Float32Array, rtSize: Float32Array, chainDesc: Uint8Array): Promise<void>;
  step(dt: number): void;
  // T5（M3/Task5）：对象级效果链。对象内容需先经 load_image 上传；set_object_effect 把它
  // 从共享场景路径移到对象路径（对象 RT + 局部相机 + 效果链 + 合成 quad）。chainDesc 为
  // 效果链 pass 描述（UTF-8 JSON 的 Uint8Array，task-8 编译链集成：内含真实 WE shader 的
  // SPIR-V bytes 数组，wasm 解析为 EffectPassDesc 走 spv_to_wgsl）。task-15 起：空/失败 →
  // **不调用**本方法（对象保持共享路径渲染原始内容，无效果链，绝不用演示渐变兜底）。
  // 返回 Promise（wasm 异步建对象效果链管线）。
  set_object_effect(objId: number, origin: Float32Array, worldSize: Float32Array, rtSize: Float32Array, chainDesc: Uint8Array): Promise<void>;
  // 每帧驱动对象级效果链（对象 RT→效果链→输出 RT）；渲染主路径 scene.render() 已自动调用，
  // 本导出供显式驱动/兼容。
  render_object_effects(): void;
  render(): void;
  scene_width(): number;
  scene_height(): number;
  // Finding 2：wasm-bindgen 生成的 WeScene 自带 free()（释放 wasm 对象/GPU 资源）。
  // 渲染器 teardown 时调用。测试 mock 通常缺省，调用侧用 free?.() 防御。
  free(): void;
}

// wasm-pack --target web 产物（wasm/pkg/we_scene_wasm.js）模块形态：
// 命名导出 WeScene；默认导出 __wbg_init（实例化 wasm，可传 wasm URL 覆盖
// import.meta.url 定位——直接 import 静态 URL 时 import.meta.url 指向
// /wallpapers/static/we_scene_wasm.js，相对定位 we_scene_wasm_bg.wasm 同样正确，
// 但显式传参更稳妥，避免与 blob/路径假设耦合）。
export interface WasmSceneModule {
  default(moduleOrPath?: string | URL | Request): Promise<unknown>;
  WeScene: { create(canvas: HTMLCanvasElement, width: number, height: number): Promise<WasmScene> };
}

export type LoadWasm = () => Promise<WasmSceneModule | null>;

// wallpaper-controller 的 sceneRenderer 接口形态（scene-renderer.ts 的 renderScene 同构）
export interface SceneRendererLike {
  render(id: string, fg: HTMLCanvasElement, bg?: HTMLCanvasElement): Promise<boolean>;
  // Finding 2：释放渲染器持有的场景 wasm 对象与脚本运行时（壁纸切换/卸载时调用，防泄漏）。
  dispose(): void;
}

// 2026-08-21 决策（强制 wasm，禁用 JS 回退）：项目主目标为 wasm 播放——
// wasm 渲染器不可用（null，如无 WebGPU）或渲染失败 → 组合层**不再降级 JS 渲染器**，
// 直接返回 false，由 controller 走 preview 图回退（场景渲染失败 ≠ 黑屏）。
// wasm 渲染器自身对带效果链壁纸不再拦截（hasEffectChains 拦截已移除）：所有 scene
// 壁纸一律走 wasm（静态图片 + GPU 粒子；效果链执行器为后续独立计划）。
// 说明：wasm 失败时 fg 可能已被 WebGPU context 占用，controller 会重建 canvas 重试，
// 组合层对已失败壁纸（wasmFailed）直接返回 false（不再尝试任何渲染器）。
export function createFallbackSceneRenderer(
  wasm: SceneRendererLike | null,
  _js: SceneRendererLike,
): SceneRendererLike {
  if (!wasm) {
    // 无 WebGPU 环境：scene 无法 wasm 渲染 → 恒 false（controller 走 preview）
    return { render: async () => false, dispose: () => {} };
  }
  // 本壁纸 wasm 已失败：后续渲染直接返回 false（不再尝试 JS）
  const wasmFailed = new Set<string>();
  return {
    async render(id, fg, bg) {
      if (!wasmFailed.has(id)) {
        const ok = await wasm.render(id, fg, bg);
        if (ok) return true;
        wasmFailed.add(id);
        return false; // wasm 失败且 fg 已被 WebGPU 污染 → controller 重建 canvas 重试
      }
      // wasmFailed：controller 已重建 canvas，但 JS 渲染已禁用 → 直接 false（preview 兜底）
      return false;
    },
    // Finding 2：透传 teardown 到底层 wasm 渲染器（JS 渲染器若实现 dispose 一并调用）。
    dispose() {
      wasm?.dispose?.();
      _js?.dispose?.();
    },
  };
}

// TS DOM lib 的 Navigator 尚未声明 WebGPU 的 gpu 属性（实验性 API），此处仅做存在性探测
interface NavigatorWithGPU { gpu?: unknown }

// 静态资源前缀与文件名（与 src/host/routes.ts 的 /wallpapers/static 路由对应；
// scripts/build-client.mjs 从 wasm/pkg/ 复制这两个文件到 dist/static/）
const STATIC_BASE = '/wallpapers/static';
const WASM_GLUE_FILE = 'we_scene_wasm.js';
const WASM_BIN_FILE = 'we_scene_wasm_bg.wasm';

async function defaultLoadWasm(): Promise<WasmSceneModule | null> {
  try {
    // 直接动态 import 静态 URL（不用 blob：blob 无路径基准，入口内 import.meta.url
    // 无法相对定位 wasm）。--target web 产物导出 default（__wbg_init），必须显式调用
    // 初始化——wasm 是惰性单例，不调 default 则 WeScene.create 内 wasm 未定义（实测
    // 'Cannot read properties of undefined (reading wescene_create)'）。
    const mod = (await import(/* @vite-ignore */ `${STATIC_BASE}/${WASM_GLUE_FILE}`)) as WasmSceneModule;
    await mod.default(`${STATIC_BASE}/${WASM_BIN_FILE}`);
    return mod;
  } catch {
    return null;
  }
}

// 图片对象纹理字节推导：obj.image → model.json → material → .tex。
// 与 scene-renderer 的 resolveImageTexture 同构，但字节流直接传 wasm（不在 JS 侧解码）。
async function resolveImageTexBytes(id: string, imageRef: string): Promise<Uint8Array | null> {
  try {
    const modelResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(imageRef)}`);
    if (!modelResp.ok) return null;
    const model: unknown = await modelResp.json();
    const matRef: unknown = (model as any)?.material;
    if (typeof matRef !== 'string' || !matRef) return null;
    const matResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(matRef)}`);
    if (!matResp.ok) return null;
    const mat: unknown = await matResp.json();
    const texName: unknown = (mat as any)?.passes?.[0]?.textures?.[0];
    if (typeof texName !== 'string' || !texName) return null;
    const texResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(resolveTexPath(matRef, texName))}`);
    if (!texResp.ok) return null;
    return new Uint8Array(await texResp.arrayBuffer());
  } catch {
    return null;
  }
}

// 粒子材质纹理字节推导（2026-08-21 方案 A）：粒子 spec 的 material → 材质 json →
// passes[0].textures[0]（如 "particle/fog/fog1"）→ **静态资源路由**
// /wallpapers/static/ptex-<斜杠转横线>.tex（build:client 已把 WE 安装目录的粒子纹理
// 打进 dist/static/，立即生效无需重启 dsh web；host 的 /wallpapers/particle-texture
// 路由为备选，重启后也可用）。任何一步失败返回 null（空字节 = 无纹理，Rust 侧
// 1×1 白兜底保持纯色粒子行为）。
//
// 2026-08-22 别名映射：部分壁纸粒子材质引用**不存在的全局纹理**（坏引用，桌面版 WE
// 同样 fallback 纯色）——1280029027(EVA) 的 light rays 材质 textures "presets/lightshaft"
// 在 WE 安装目录无对应文件，但真实光柱纹理 particle/light/light_shafts_0.tex 存在
// （build:client 已复制）。映射到真实纹理让粒子恢复纹理形状（优于桌面版纯色兜底）。
const PARTICLE_TEX_ALIASES: Record<string, string> = {
  // "presets/lightshaft"（无下划线，EVA 坏引用）→ light_shafts 序列第 0 帧（光柱精灵）。
  // 值是 **short 形式**（去 particle/ 前缀，与下方 short 计算后一致）→ ptex-light-light_shafts_0.tex
  'presets/lightshaft': 'light/light_shafts_0',
};
async function resolveParticleTexBytes(id: string, specText: string): Promise<Uint8Array | null> {
  try {
    const spec: unknown = JSON.parse(specText);
    const matRef: unknown = (spec as { material?: unknown })?.material;
    if (typeof matRef !== 'string' || !matRef) return null;
    const matResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(matRef)}`);
    if (!matResp.ok) return null;
    const mat: unknown = await matResp.json();
    const texName: unknown = (mat as { passes?: { textures?: unknown[] }[] })?.passes?.[0]?.textures?.[0];
    if (typeof texName !== 'string' || !texName) return null;
    // 静态资源（立即生效）：build:client 从 WE 安装目录 assets/materials/particle/ 复制，
    // 相对该目录扁平命名 ptex-<路径斜杠转横线>.tex → "particle/fog/fog1" → ptex-fog-fog1.tex
    const short = texName.startsWith('particle/') ? texName.slice('particle/'.length) : texName;
    const resolved = PARTICLE_TEX_ALIASES[short] ?? short;
    const texResp = await fetch(`/wallpapers/static/ptex-${encodeURIComponent(resolved.replace(/\//g, '-'))}.tex`);
    if (!texResp.ok) return null;
    const buf = await texResp.arrayBuffer();
    if (buf.byteLength === 0) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

export function createWasmSceneRenderer(opts?: { loadWasm?: LoadWasm }): SceneRendererLike | null {
  // 无 WebGPU（navigator.gpu falsy，含 SSR/测试环境）→ null，controller 走现有 JS 渲染回退
  if (typeof navigator === 'undefined' || !(navigator as NavigatorWithGPU).gpu) return null;
  const loadWasm = opts?.loadWasm ?? defaultLoadWasm;
  // 模块加载缓存：同一 renderer 内多次 render 只加载/初始化一次 wasm
  let modulePromise: Promise<WasmSceneModule | null> | null = null;
  // Finding 2：跨 render 调用持有本次渲染创建的 scene / 脚本运行时，供替换/dispose 时释放。
  // 每次 render 会重建 scene + 启新 raf 循环；旧资源在下次 render 开头或 dispose() 时释放。
  let currentScene: WasmScene | null = null;
  let currentScriptRuntime: SceneScriptRuntime | null = null;
  let raf = 0;
  const teardown = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    currentScriptRuntime?.dispose();
    currentScriptRuntime = null;
    currentScene?.free?.();
    currentScene = null;
  };
  return {
    async render(id, fg, bg) {
      try {
        // Finding 2：替换（重试/切壁纸）前先释放上次渲染资源（首次渲染无资源 → no-op）。
        teardown();
        modulePromise ??= loadWasm();
        const mod = await modulePromise;
        if (!mod) return false;
        // 拉取场景描述并解析（与 JS 渲染器共用 parseSceneJson，对象归类/正交尺寸语义一致）
        const sceneJsonResp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
        if (!sceneJsonResp.ok) return false;
        const sceneJson = await sceneJsonResp.text();
        const desc = parseSceneJson(sceneJson);
        // 2026-08-21 决策（强制 wasm，禁用 JS 回退）：不再检测 hasEffectChains 拦截——
        // 带效果链壁纸也走 wasm 渲染（静态图片 + GPU 粒子）；wasm 内效果链执行器为
        // 后续独立计划（wasm-renderer 无需在此处返回 false，避免 wasm 被绕过）。
        const { width, height } = desc.orthogonal;
        // Task 9 修复：surface 与 canvas 属性尺寸 = 视口（对齐 scene-renderer.setScene 的
        // vw/vh 语义；原实现直接传场景正交尺寸，canvas 默认 300×150 → 渲染被拉伸/截图失真）
        const vw = Math.max(1, Math.round(window.innerWidth || width));
        const vh = Math.max(1, Math.round(window.innerHeight || height));
        fg.width = vw;
        fg.height = vh;
        const scene = await mod.WeScene.create(fg, vw, vh);
        currentScene = scene; // Finding 2：持有引用，teardown/dispose 时 free()
        // 2026-08-21 铺满全屏改造（用户需求）：前景 = cover 相机 + 场景 clearcolor 清屏
        // （不透明）——对齐桌面版默认 FillMode::ASPECTCROP（铺满、不变形、超出方向裁剪）。
        // 原先景 contain（留白透明）+ 背景模糊层（Task 9）已废弃：前景不透明清屏后背景层
        // 完全不可见，故移除背景层创建（bg 参数忽略，单层渲染贴近桌面版）。
        scene.set_cover();
        scene.load_scene(sceneJson);
        // 对象遍历：image → 纹理字节直传 wasm；particle → 规格 json 直传；util 跳过
        // （与 scene-renderer.ts 语义一致；assetId 用对象索引保证单场景内唯一）
        // T4.2 可见性过滤（与 scene-renderer.renderScene 的 visibleObjects 过滤一致）：
        // wasm 路径无用户属性注入（settings 查询仅 JS 路径有），传 {} → user 绑定回退
        // 绑定 value（= 无用户属性存储的缺省语义）；不可见对象整体跳过——不加载纹理/
        // 粒子、不计入 rendered（全不可见 → rendered===0 → 下方 preview 回退，同 JS 路径）。
        let rendered = 0;
        // T5：脚本动画（SceneScriptRuntime，Task 4）。懒初始化：首个带脚本的 image 对象
        // 才 create()（quickjs wasm 懒加载）；失败保持 null → 无动画（静态渲染）。
        // scriptBindings 收集 { assetId: 对象索引, bound }，每帧更新读回灌回 update_image。
        let scriptRuntime: SceneScriptRuntime | null = null;
        const scriptBindings: Array<{ assetId: number; bound: NonNullable<ReturnType<SceneScriptRuntime['bind']>> }> = [];
        for (let i = 0; i < desc.objects.length; i++) {
          const obj = desc.objects[i];
          if (!resolveVisibility(obj, {})) continue;
          if (obj.kind === 'image') {
            const tex = await resolveImageTexBytes(id, obj.image);
            if (!tex) continue; // 纹理缺失 → 跳过该对象（与 JS 渲染器一致）
            // T4.1：alignment 锚点 → 中心（Controller Ruling P4-1：JS 侧预处理 origin，
            // Rust 保持「origin=中心」约定不改）。世界尺寸 = size×scale（场景像素）；
            // 纹理尺寸在本路径 origin 计算时未知（字节直传 wasm，不解码）→ size 缺省
            // 时跳过 alignment（origin 原样直传，等效 center 无偏移，与 JS 路径的
            // 「缺省回退纹理宽高」在此场景下的差异属预期，见任务 brief）。
            const size = obj.size;
            const origin = size
              ? applyAlignment(obj.origin, [size[0] * obj.scale[0], size[1] * obj.scale[1]], obj.alignment)
              : obj.origin;
            // T4.3：对象调制输入直传 wasm（空 Float32Array = 缺省 → Rust image_tint
            // 按无调制处理，与 JS 路径 materialModulation 全缺省 {1,1,1,1} 对齐）
            // 对象级效果链（M3/Task5）：带 effects 的 image 对象走对象路径（对象 RT + 局部相机
            // + 效果链 + 合成 quad），无效果对象走现有共享场景路径（load_image）。对象内容纹理先
            // 经 load_image 上传（登记对象内容），再 set_object_effect 把它从共享路径移到对象效果
            // 路径。chainDesc 由 buildEffectChainDesc 产出（task-8 编译链集成：真实 WE shader 的
            // SPIR-V）；解析失败/无 pass → 空 Uint8Array（wasm 用内置演示 pass 兜底，绝不白屏）。
            // world_size/rt_size 在 size 缺省时传空，wasm 侧从内容推导（不退化到 1px）。
            const isObjectPath = shouldUseObjectPath(obj);
            const range = size ? objectCameraRange(size, [obj.scale[0], obj.scale[1]]) : null;
            scene.load_image(
              i,
              tex,
              Float32Array.from(origin),
              Float32Array.from(obj.scale),
              Float32Array.from(size ?? []),
              Float32Array.from(obj.color ?? []),
              Float32Array.from(obj.alpha !== undefined ? [obj.alpha] : []),
              Float32Array.from(obj.brightness !== undefined ? [obj.brightness] : []),
            );
            if (isObjectPath) {
              const worldSize = size ? [size[0] * obj.scale[0], size[1] * obj.scale[1]] : [];
              const rtSize = range ? [range.w, range.h] : [];
              const chainDesc = await buildEffectChainDesc(id, obj.effects);
              // task-15（编译失败 → 原始内容，非演示渐变）：chainDesc 非空（真实 WE shader 编译出
              // 有效 SPIR-V）→ 走对象级效果链（对象 RT + 效果链 + 合成 quad）。空（编译失败/无有效
              // pass）→ **不**调 set_object_effect——对象保持上面的共享路径 load_image（原始内容，
              // 无效果），绝不用 wasm 内置演示渐变覆盖对象内容。
              if (chainDesc.length > 0) {
                await scene.set_object_effect(
                  i,
                  Float32Array.from(origin),
                  Float32Array.from(worldSize),
                  Float32Array.from(rtSize),
                  chainDesc,
                );
              } else {
                console.warn(`[wasm] 对象 ${i}(image) 效果链编译失败/无有效 pass → 保持共享路径，显示原始内容（非渐变）`);
              }
            }
            rendered++;
            // T5：仅 image 对象且带非空 script 时绑定（text/particle/util 不处理）。
            // 可见性已在上方 resolveVisibility 过滤（不可见对象 skip，不产生 binding——
            // 其 i 仍是原索引，update_image 用原索引与 load_image 匹配）。
            if (obj.script && obj.script.trim()) {
              scriptRuntime ??= await SceneScriptRuntime.create(); // 懒初始化（失败保持 null = 无动画）
              // Finding 1：脚本初始 origin 必须与 load_image 渲染用的对齐中心一致，
              // 否则首帧 readback 会把原始锚点灌回 SceneImage，撤销 alignment 偏移。
              // ScriptReadback 基线（committed）也由此对齐 origin 初始化 → 无改动时不灌回。
              if (scriptRuntime) currentScriptRuntime = scriptRuntime; // Finding 2：持引用，teardown 时 dispose
              const bound = scriptRuntime?.bind(obj.script, {
                origin,
                scale: obj.scale,
                alpha: obj.alpha ?? 1,
                brightness: obj.brightness ?? 1,
              });
              if (bound) scriptBindings.push({ assetId: i, bound });
            }
          } else if (obj.kind === 'particle' && obj.particle) {
            const specResp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(obj.particle)}`);
            if (!specResp.ok) continue;
            const specText = await specResp.text();
            // 2026-08-21（方案 A）：解析粒子材质纹理（spec.material → passes[0].textures[0]，
            // 如 "particle/fog/fog1" → /wallpapers/particle-texture）→ TEXV0005 字节直传
            // wasm。纹理缺失（引擎内置资源不可用）→ 空字节 = 无纹理（Rust 用 1×1 白兜底，
            // 保持纯色粒子行为）。
            const texBytes = await resolveParticleTexBytes(id, specText);
            // 对象级效果链（M4/Task6）：带 effects 的粒子对象走对象路径（粒子内容→对象RT→
            // 效果链→合成 quad），复用 image 路径的 buildEffectChainDesc 产出真实 WE shader 的
            // SPIR-V chainDesc；无效果粒子保持共享场景路径（add_particle）。世界尺寸/对象RT
            // 范围用粒子发射距离估计（particleWorldSize/particleObjectRange，与 JS renderer
            // addParticleSystem 同构），origin 按 alignment 换算中心（对齐 JS 对象路径）。
            const isObjectPath = shouldUseObjectPath(obj);
            if (isObjectPath) {
              const spec: unknown = JSON.parse(specText);
              const emitter = (spec as { emitter?: { distanceMax?: number } })?.emitter ?? {};
              const world = particleWorldSize(emitter, [obj.scale[0], obj.scale[1]]);
              const range = particleObjectRange(emitter, [obj.scale[0], obj.scale[1]]);
              const center = applyAlignment(obj.origin, [world.w, world.h], obj.alignment);
              const chainDesc = await buildEffectChainDesc(id, obj.effects);
              // task-15（编译失败 → 原始内容，非演示渐变）：chainDesc 非空 → 走对象级效果链；
              // 空（编译失败/无有效 pass）→ **不**调 set_particle_object_effect，改走共享路径
              // add_particle（原始粒子内容，无效果链），绝不用 wasm 内置演示渐变覆盖粒子内容。
              if (chainDesc.length > 0) {
                await scene.set_particle_object_effect(
                  i,
                  specText,
                  Float32Array.from(center),
                  Float32Array.from(obj.scale),
                  texBytes ?? new Uint8Array(0),
                  Float32Array.from([world.w, world.h]),
                  Float32Array.from([range.w, range.h]),
                  chainDesc,
                );
              } else {
                console.warn(`[wasm] 对象 ${i}(particle) 效果链编译失败/无有效 pass → 共享路径 add_particle，显示原始内容（非渐变）`);
                scene.add_particle(
                  specText,
                  Float32Array.from(obj.origin),
                  Float32Array.from(obj.scale),
                  texBytes ?? new Uint8Array(0),
                );
              }
            } else {
              scene.add_particle(
                specText,
                Float32Array.from(obj.origin),
                Float32Array.from(obj.scale),
                texBytes ?? new Uint8Array(0),
              );
            }
            rendered++;
          }
        }
        // 全部对象渲染失败 → 返回 false，controller 走 preview 回退（回退链接线）
        if (rendered === 0) {
          // Finding 2：释放本次已创建但未进入循环的 scene/脚本运行时（不泄漏）。
          teardown();
          return false;
        }
        const loop = () => {
          scene.step(1 / 60);
          // T5：脚本状态灌回——每帧对每个绑定 update(1/60)，读回变化灌回 update_image。
          // undefined = 保持当前（origin/scale 为 Float32Array，alpha/brightness 为 number）。
          // Finding 3：BoundScript.update 已做变化检测——未变字段省略（rb 为空对象则不灌回），
          // 避免对静态对象每帧做 wasm-bindgen 往返 + Float32Array.from 分配。
          for (const { assetId, bound } of scriptBindings) {
            const rb = bound.update(1 / 60);
            if (!rb) continue; // 脚本抛错 → 该对象停动画（隔离），不灌回
            const hasChange =
              rb.origin || rb.scale || rb.imageAlpha !== undefined || rb.imageBrightness !== undefined;
            if (!hasChange) continue; // 无变化 → 不触发 update_image（保持现状）
            scene.update_image(
              assetId,
              rb.origin ? Float32Array.from([rb.origin.x, rb.origin.y, rb.origin.z]) : undefined,
              rb.scale ? Float32Array.from([rb.scale.x, rb.scale.y, rb.scale.z]) : undefined,
              rb.imageAlpha,
              rb.imageBrightness,
            );
          }
          scene.render();
          // canvas 被 controller 移除（切换壁纸）时自动终止 raf，防止泄漏
          if (fg.isConnected) raf = requestAnimationFrame(loop);
        };
        raf = requestAnimationFrame(loop);
        return true;
      } catch {
        // Finding 2：异常路径释放已创建的 scene/脚本运行时（不泄漏）。
        teardown();
        return false;
      }
    },
    // Finding 2：释放当前场景与脚本运行时（取消运行中的 raf 循环）。调用方（controller）
    // 在壁纸切换/卸载时调用，避免每次 render 泄漏一个 quickjs 运行时 + wasm scene。
    dispose() {
      teardown();
    },
  };
}
