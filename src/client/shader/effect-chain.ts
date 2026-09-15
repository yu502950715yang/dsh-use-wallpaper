// src/client/shader/effect-chain.ts
// 效果链解析：effect.json → material → shader，合并 scene.json 覆写，产出可执行 pass。
import { preprocessWeShader, extractUniformAnnotations, extractComboDefaults } from './shader-preprocessor.js';
import { resolveUniformBindings, type UniformValue } from './uniform-binder.js';

export interface CompiledEffectPass {
  vertSrc: string;                       // 供 three 使用的预处理后 GLSL3
  fragSrc: string;                       // 供 three 使用的预处理后 GLSL3
  rawVert: string;                       // 未预处理的原始 WE 方言 vert 源（供 wasm 路径）
  rawFrag: string;                       // 未预处理的原始 WE 方言 frag 源（供 wasm 路径）
  combos: Record<string, number>;        // 该 pass 的 combo 宏映射（scene.json 覆写 + 需注入项）
  uniforms: Map<string, UniformValue>;   // 静态值（g_Time 由执行器运行时更新）
  textureSlots: (string | null)[];       // textures[i] → g_Texture(i)（WE 官方 scenejson.md:22）
  // 每个 sampler uniform 名 → 该槽在 shader 注释里声明的 `mode`（如 g_Texture2 → "opacitymask"）。
  // 只收 mode 非空的声明；vert 与 frag 都扫（同名以 frag 为准——采样发生在片元侧）。
  // 用途：scene.json 的 textures 数组**没给到**某个槽时，执行器按 mode 决定空槽绑什么常量纹理
  // （opacitymask → 全 0、flowmask → 中灰；无 mode 的槽不碰，保持既有行为）。
  // 见 effect-runner.ts 的 resolveEmptySlotTexture / resolveSlotFallback。
  samplerModes: Record<string, string>;
  blendMode: string;                     // material json 的 blending（normal/add/...）
  // ── RT 图信息（wasm RT 图执行器）──
  // effect.json passes[i].target：本 pass 写到的具名 RT（如 "_rt_QuarterCompoBuffer1"）。
  // 缺省/空 = 最终输出（对象 out RT）。wasm 据此决定写哪张 RT（具名中间 RT 或最终输出）。
  target: string | null;
  // effect.json passes[i].bind：本 pass 的纹理采样来源（bind.name 引用具名 RT / "previous" /
  // 空 = sampler2D 输入）。wasm 据此把 shader 的 g_TextureN 绑到具名 RT / 起始输入 / 独立纹理。
  bind: { name: string; index: number }[];
  // effect.json 顶层 fbos：具名 RT 的"降采样声明"（scale:4 = 1/4 尺寸），wasm 建多尺寸 RT 池用。
  // 键 = fbo 名字（"_rt_QuarterCompoBuffer1"），值 = scale（4）/format。
  fboScale: Record<string, number>;
}

interface SceneEffectPass { material?: string; combos?: Record<string, number>; constantshadervalues?: Record<string, unknown>; textures?: (string | null)[]; target?: string; bind?: { name: string; index: number }[] }

export async function resolveEffectChain(
  sceneEffect: { file: string; passes?: unknown[] },
  loadFile: (name: string) => Promise<Uint8Array | null>,
): Promise<CompiledEffectPass[] | null> {
  try {
    const effectRaw = await loadFile(sceneEffect.file);
    if (!effectRaw) return null;
    // effect.json 类型：passes[]（material/target/bind）+ fbos[]（具名 RT 降采样声明）。
    // 保留 target/bind/fbos 供 wasm RT 图执行器（丢弃会导致 blur/clouds 等"多 pass + 具名中间
    // RT + 降采样"场景主图丢失）。
    const effect = JSON.parse(new TextDecoder().decode(effectRaw)) as {
      passes?: { material?: string; target?: string; bind?: { name: string; index: number }[] }[];
      fbos?: { name: string; scale: number }[];
    };
    // fbo 降采样表：name → scale（缺省 scale=1 = 全尺寸）。wasm 据此建多尺寸 RT。
    const fboScale: Record<string, number> = {};
    for (const fb of effect.fbos ?? []) {
      if (fb?.name) fboScale[fb.name] = fb.scale > 0 ? fb.scale : 1;
    }
    const scenePasses = Array.isArray(sceneEffect.passes) ? sceneEffect.passes as SceneEffectPass[] : [];
    if (!Array.isArray(effect.passes) || effect.passes.length === 0) return null;

    const out: CompiledEffectPass[] = [];
    for (let i = 0; i < effect.passes.length; i++) {
      const scenePass = scenePasses[i] ?? {};
      // material 引用：scene.json pass 显式指定时优先（覆写），否则用 effect.json 的引用
      const matRef = scenePass.material ?? effect.passes[i].material;
      if (typeof matRef !== 'string') return null;
      // WE 内置 util 材质（materials/util/*，如 effectcomposebackground.json）：pkg 内无文件，
      // 是引擎内置合成 pass（compose），跳过该 pass 继续解析后续真实效果 pass。
      if (matRef.startsWith('materials/util/')) continue;
      const matRaw = await loadFile(matRef);
      if (!matRaw) return null;
      const mat = JSON.parse(new TextDecoder().decode(matRaw)) as { passes?: { shader?: string; blending?: string }[] };
      const shaderName = mat.passes?.[0]?.shader;
      if (typeof shaderName !== 'string') return null;
      const vertRaw = await loadFile(`shaders/${shaderName}.vert`);
      const fragRaw = await loadFile(`shaders/${shaderName}.frag`);
      if (!vertRaw || !fragRaw) return null;

      const override = scenePasses[i] ?? {};
      const constants = override.constantshadervalues ?? {};
      const textures = Array.isArray(override.textures) ? override.textures : [];

      // 原始源（未预处理，供 wasm 路径用 glsl-to-naga 编译）：在调用 preprocessWeShader 之前保存
      const rawVert = new TextDecoder().decode(vertRaw);
      const rawFrag = new TextDecoder().decode(fragRaw);

      // ── combo 派生（WE 语义，必须在 preprocessWeShader **之前**，因为 combo 决定 #if 分支）──
      // shader 里 sampler 声明带 `"combo":"X"` 时，**该槽被绑定（textures 对应项非 null）即置 X=1**。
      // 典型：`uniform sampler2D g_Texture3; // {"mode":"opacitymask","combo":"MASK"}`
      // 与 `g_Texture1; // {"mode":"flowmask","default":"util/noflow"}`——mask/方向图被绑定时，
      // `#if MASK` 的局部作用分支才会启用；不启用时效果会**全图**生效（而不是只作用于 mask 区域），
      // 这正是「GTR 整屏抖动而不是只抖排气管」的根因之一。
      // scene.json 的 pass.combos 显式值优先（覆盖派生结果）。
      const derived: Record<string, number> = {};
      for (const ann of extractUniformAnnotations(rawFrag).concat(extractUniformAnnotations(rawVert))) {
        const combo = ann.annotation?.combo;
        if (typeof combo !== 'string' || !combo) continue;
        const m = /^g_Texture(\d+)$/.exec(ann.name);
        if (!m) continue;
        const idx = Number(m[1]);
        // textures[i] → g_Texture(i)；g_Texture0 是效果链输入（由执行器绑定 readTex），
        // 故只对 idx ≥ 1 做派生。
        if (idx > 0 && textures[idx]) derived[combo] = 1;
      }
      const combos: Record<string, number> = { ...derived, ...(override.combos ?? {}) };
      // combo 宏整 pass 共用（lwe ShaderUnit.cpp:694-714 / WE layerd WPSceneParser.cpp:1643-1644）：
      // [COMBO] 默认常只写在一侧，另一侧会兜底成 0 ⇒ 两侧注入不同 ⇒ 链接失败（序同 glsl-to-naga.passCombos）。
      for (const raw of [rawVert, rawFrag]) {
        for (const [k, v] of extractComboDefaults(raw)) if (!(k in combos)) combos[k] = v;
      }
      const vertSrc = preprocessWeShader(rawVert, combos);
      const fragSrc = preprocessWeShader(rawFrag, combos);
      // sampler 槽的 mode 标注（空槽语义的唯一依据）：**必须扫未预处理的原始源** —— 
      // preprocessWeShader 会把 `uniform sampler2D x; // {...}` 整行抽出来前置，
      // 处理后再扫拿不到标注（注释已随行被搬走/丢失）。
      // 合并顺序：vert → frag，同名（同一槽在两侧都声明）时以 frag 为准。
      const samplerModes: Record<string, string> = {};
      for (const ann of extractUniformAnnotations(rawVert).concat(extractUniformAnnotations(rawFrag))) {
        const mode = ann.annotation?.mode;
        if (typeof mode === 'string' && mode) samplerModes[ann.name] = mode;
      }
      const uniforms = resolveUniformBindings(
        extractUniformAnnotations(fragSrc).concat(extractUniformAnnotations(vertSrc)),
        constants,
      );
      const effPass = effect.passes[i];
      out.push({
        vertSrc,
        fragSrc,
        rawVert,
        rawFrag,
        combos,
        uniforms,
        textureSlots: textures,
        samplerModes,
        blendMode: mat.passes?.[0]?.blending ?? 'normal',
        // RT 图信息：effect.json passes[i].target（写到的具名 RT）/bind（采样来源）；
        // scene.json pass 可覆写 target（如 scene 指定目标 RT）。缺省 target=null（最终输出）。
        target: (scenePass.target ?? effPass.target) || null,
        bind: Array.isArray(effPass.bind) ? effPass.bind : [],
        fboScale,
      });
    }
    // 全部 pass 为内置 util 材质（被跳过）→ 无可执行 pass，与 passes 为空语义一致
    if (out.length === 0) return null;
    return out;
  } catch {
    return null;
  }
}
