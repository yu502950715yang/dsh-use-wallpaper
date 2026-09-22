// materials/**/*.json → three 材质。WE 材质结构：{ passes: [{ shader, textures[],
// blending, cullmode, depthtest, depthwrite, constantshadervalues }] }，纹理路径相对 `materials/`。
import * as THREE from 'three';
import { PARTICLE_MESH_VERT, PARTICLE_MESH_FRAG, PARTICLE_ALPHA_FRAG } from './mesh-shaders.js';
/** 解析材质 json 的 `passes[0]`。空/畸形/无 pass → null（调用方回退白图兜底材质）。 */
export function parseMeshMaterial(jsonText) {
    if (typeof jsonText !== 'string' || !jsonText)
        return null;
    let json;
    try {
        json = JSON.parse(jsonText);
    }
    catch {
        return null;
    }
    const passes = json?.passes;
    if (!Array.isArray(passes) || passes.length === 0)
        return null;
    const p = passes[0];
    const textures = Array.isArray(p.textures) ? p.textures : [];
    const first = textures.length > 0 ? textures[0] : null;
    return {
        shader: typeof p.shader === 'string' ? p.shader : '',
        texturePath: typeof first === 'string' && first ? first : null,
        // spec §6.2：`add`/`additive` → 加性，其余（translucent 等）→ 常规混合
        blending: /^(add|additive)$/i.test(String(p.blending ?? '')) ? 'additive' : 'normal',
        // WE 的 cullmode 取值语义未确定；粒子/拖尾 quad 本来就要求双面可见，统一双面最安全
        side: THREE.DoubleSide,
        // depthtest 缺省开、depthwrite 缺省关（半透明粒子不该写深度）
        depthTest: p.depthtest !== false,
        depthWrite: p.depthwrite === true,
    };
}
/** 白图兜底参数：材质缺失/解析失败时用它（绝不整场失败），与既有粒子路径同语义。 */
const FALLBACK_SPEC = {
    shader: 'we2d_particle_mesh', texturePath: null, blending: 'additive',
    side: THREE.DoubleSide, depthTest: true, depthWrite: false,
};
/** 建 three 材质。spec 为 null（材质缺失/解析失败）→ 白图兜底（不整场失败）。 */
export function createMeshMaterial(spec, texture) {
    const s = spec ?? FALLBACK_SPEC;
    // shader 名带 alpha 的走 alpha 层片元（rgb 输出白、纹理 alpha 当遮罩），其余走颜色层
    const isAlpha = /alpha/i.test(s.shader);
    const uniforms = {
        g_Texture0: { value: texture ?? sharedWhiteTexture() },
        // (内容宽, 内容高, 打包宽, 打包高)：(1,1,1,1) ⇒ shader 里的 uv 修正为恒等（见 mesh-shaders.ts）
        g_Texture0Resolution: { value: new THREE.Vector4(1, 1, 1, 1) },
    };
    return new THREE.ShaderMaterial({
        uniforms,
        vertexShader: PARTICLE_MESH_VERT,
        fragmentShader: isAlpha ? PARTICLE_ALPHA_FRAG : PARTICLE_MESH_FRAG,
        transparent: true,
        depthTest: s.depthTest,
        depthWrite: s.depthWrite,
        side: s.side,
        blending: s.blending === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
}
// 1×1 白图：共享实例（材质可能被多个 mesh 复用，纹理不必重复占显存）
let whiteTex = null;
function sharedWhiteTexture() {
    if (!whiteTex) {
        whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
        whiteTex.needsUpdate = true;
    }
    return whiteTex;
}
