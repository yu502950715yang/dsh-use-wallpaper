// src/client/shader/effect-chain.ts
// 效果链解析：effect.json → material → shader，合并 scene.json 覆写，产出可执行 pass。
import { preprocessWeShader, extractUniformAnnotations } from './shader-preprocessor.js';
import { resolveUniformBindings } from './uniform-binder.js';
export async function resolveEffectChain(sceneEffect, loadFile) {
    try {
        const effectRaw = await loadFile(sceneEffect.file);
        if (!effectRaw)
            return null;
        const effect = JSON.parse(new TextDecoder().decode(effectRaw));
        const scenePasses = Array.isArray(sceneEffect.passes) ? sceneEffect.passes : [];
        if (!Array.isArray(effect.passes) || effect.passes.length === 0)
            return null;
        const out = [];
        for (let i = 0; i < effect.passes.length; i++) {
            // material 引用：scene.json pass 显式指定时优先（覆写），否则用 effect.json 的引用
            const matRef = scenePasses[i]?.material ?? effect.passes[i].material;
            if (typeof matRef !== 'string')
                return null;
            // WE 内置 util 材质（materials/util/*，如 effectcomposebackground.json）：pkg 内无文件，
            // 是引擎内置合成 pass（compose），跳过该 pass 继续解析后续真实效果 pass
            // （Task 6 Ruling 5 落地：2911105183 refraction 链实测暴露，全库仅此 1 处）
            if (matRef.startsWith('materials/util/'))
                continue;
            const matRaw = await loadFile(matRef);
            if (!matRaw)
                return null;
            const mat = JSON.parse(new TextDecoder().decode(matRaw));
            const shaderName = mat.passes?.[0]?.shader;
            if (typeof shaderName !== 'string')
                return null;
            const vertRaw = await loadFile(`shaders/${shaderName}.vert`);
            const fragRaw = await loadFile(`shaders/${shaderName}.frag`);
            if (!vertRaw || !fragRaw)
                return null;
            const override = scenePasses[i] ?? {};
            const combos = override.combos ?? {};
            const constants = override.constantshadervalues ?? {};
            const textures = Array.isArray(override.textures) ? override.textures : [];
            const vertSrc = preprocessWeShader(new TextDecoder().decode(vertRaw), combos);
            const fragSrc = preprocessWeShader(new TextDecoder().decode(fragRaw), combos);
            const uniforms = resolveUniformBindings(extractUniformAnnotations(fragSrc).concat(extractUniformAnnotations(vertSrc)), constants);
            out.push({
                vertSrc,
                fragSrc,
                uniforms,
                textureSlots: textures,
                blendMode: mat.passes?.[0]?.blending ?? 'normal',
            });
        }
        // 全部 pass 为内置 util 材质（被跳过）→ 无可执行 pass，与 passes 为空语义一致
        if (out.length === 0)
            return null;
        return out;
    }
    catch {
        return null;
    }
}
