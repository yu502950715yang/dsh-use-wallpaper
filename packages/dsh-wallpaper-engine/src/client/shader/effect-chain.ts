// src/client/shader/effect-chain.ts
// 效果链解析：effect.json → material → shader，合并 scene.json 覆写，产出可执行 pass。
import { preprocessWeShader, extractUniformAnnotations } from './shader-preprocessor.js';
import { resolveUniformBindings, type UniformValue } from './uniform-binder.js';

export interface CompiledEffectPass {
  vertSrc: string;
  fragSrc: string;
  uniforms: Map<string, UniformValue>;   // 静态值（g_Time 由执行器运行时更新）
  textureSlots: (string | null)[];       // textures[i] → g_Texture(i+1)
  blendMode: string;                     // material json 的 blending（normal/add/...）
}

interface SceneEffectPass { material?: string; combos?: Record<string, number>; constantshadervalues?: Record<string, unknown>; textures?: (string | null)[] }

export async function resolveEffectChain(
  sceneEffect: { file: string; passes?: unknown[] },
  loadFile: (name: string) => Promise<Uint8Array | null>,
): Promise<CompiledEffectPass[] | null> {
  try {
    const effectRaw = await loadFile(sceneEffect.file);
    if (!effectRaw) return null;
    const effect = JSON.parse(new TextDecoder().decode(effectRaw)) as { passes?: { material?: string }[] };
    const scenePasses = Array.isArray(sceneEffect.passes) ? sceneEffect.passes as SceneEffectPass[] : [];
    if (!Array.isArray(effect.passes) || effect.passes.length === 0) return null;

    const out: CompiledEffectPass[] = [];
    for (let i = 0; i < effect.passes.length; i++) {
      // material 引用：scene.json pass 显式指定时优先（覆写），否则用 effect.json 的引用
      const matRef = scenePasses[i]?.material ?? effect.passes[i].material;
      if (typeof matRef !== 'string') return null;
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

      const vertSrc = preprocessWeShader(new TextDecoder().decode(vertRaw), combos);
      const fragSrc = preprocessWeShader(new TextDecoder().decode(fragRaw), combos);
      const uniforms = resolveUniformBindings(
        extractUniformAnnotations(fragSrc).concat(extractUniformAnnotations(vertSrc)),
        constants,
      );
      out.push({
        vertSrc,
        fragSrc,
        uniforms,
        textureSlots: textures,
        blendMode: mat.passes?.[0]?.blending ?? 'normal',
      });
    }
    return out;
  } catch {
    return null;
  }
}
