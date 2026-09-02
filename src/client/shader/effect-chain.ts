// src/client/shader/effect-chain.ts
// 效果链解析：effect.json → material → shader，合并 scene.json 覆写，产出可执行 pass。
import { preprocessWeShader, extractUniformAnnotations } from './shader-preprocessor.js';
import { resolveUniformBindings, type UniformValue } from './uniform-binder.js';

export interface CompiledEffectPass {
  vertSrc: string;                       // 供 three 使用的预处理后 GLSL3
  fragSrc: string;                       // 供 three 使用的预处理后 GLSL3
  rawVert: string;                       // 未预处理的原始 WE 方言 vert 源（供 wasm 路径）
  rawFrag: string;                       // 未预处理的原始 WE 方言 frag 源（供 wasm 路径）
  combos: Record<string, number>;        // 该 pass 的 combo 宏映射（scene.json 覆写 + 需注入项）
  uniforms: Map<string, UniformValue>;   // 静态值（g_Time 由执行器运行时更新）
  textureSlots: (string | null)[];       // textures[i] → g_Texture(i+1)
  blendMode: string;                     // material json 的 blending（normal/add/...）
  // ── RT 图信息（2026-08-31 阶段1：wasm 效果链升级为 RT 图执行器）──
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
    // 2026-08-31 阶段1（wasm RT 图执行器）：保留 target/bind/fbos（此前被丢弃，导致
    // blur/clouds 等"多 pass + 具名中间 RT + 降采样"场景主图丢失）。
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
      // 是引擎内置合成 pass（compose），跳过该 pass 继续解析后续真实效果 pass
      // （Task 6 Ruling 5 落地：2911105183 refraction 链实测暴露，全库仅此 1 处）
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
      const combos = override.combos ?? {};
      const constants = override.constantshadervalues ?? {};
      const textures = Array.isArray(override.textures) ? override.textures : [];

      // 原始源（未预处理，供 wasm 路径用 glsl-to-naga 编译）：在调用 preprocessWeShader 之前保存
      const rawVert = new TextDecoder().decode(vertRaw);
      const rawFrag = new TextDecoder().decode(fragRaw);
      const vertSrc = preprocessWeShader(rawVert, combos);
      const fragSrc = preprocessWeShader(rawFrag, combos);
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
        blendMode: mat.passes?.[0]?.blending ?? 'normal',
        // RT 图信息（阶段1）：effect.json passes[i].target（写到的具名 RT）/bind（采样来源）；
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
