// tests/effect-chain.test.ts
import { describe, expect, it } from 'vitest';
import { resolveEffectChain } from '../src/client/shader/effect-chain.js';

const encoder = new TextEncoder();
// 最小真实结构 fixture（对应 2911105183 的 waterwaves 链）
const files = new Map<string, Uint8Array>([
  ['effects/waterwaves/effect.json', encoder.encode(JSON.stringify({
    version: 1,
    passes: [{ material: 'materials/effects/waterwaves.json' }],
    dependencies: ['materials/effects/waterwaves.json', 'shaders/effects/waterwaves.frag', 'shaders/effects/waterwaves.vert'],
  }))],
  ['materials/effects/waterwaves.json', encoder.encode(JSON.stringify({
    passes: [{ shader: 'effects/waterwaves', blending: 'normal', depthtest: 'disabled', depthwrite: 'disabled', cullmode: 'nocull' }],
  }))],
  ['shaders/effects/waterwaves.vert', encoder.encode('uniform mat4 g_ModelViewProjectionMatrix;\nvoid main() { gl_Position = mul(vec4(a_Position,1.0), g_ModelViewProjectionMatrix); }')],
  ['shaders/effects/waterwaves.frag', encoder.encode('#include "common.h"\nuniform float g_Speed; // {"material":"speed","default":5}\nvoid main() { gl_FragColor = vec4(g_Speed); }')],
]);
const loadFile = async (name: string) => files.get(name) ?? null;

describe('resolveEffectChain', () => {
  it('合并 scene.json 覆写并产出编译 pass', async () => {
    const chain = await resolveEffectChain({
      file: 'effects/waterwaves/effect.json',
      passes: [{
        id: 245,
        combos: { MASK: 1 },
        constantshadervalues: { speed: 2.5, strength: 0.5 },
        textures: [null, 'masks/waterwaves_mask_e0eafd2b'],
      }],
    }, loadFile);
    expect(chain).not.toBeNull();
    const pass = chain![0];
    expect(pass.blendMode).toBe('normal');
    expect(pass.vertSrc).toContain('g_ModelViewProjectionMatrix');
    expect(pass.fragSrc).toContain('#define MASK 1');      // combo 注入
    expect(pass.fragSrc).toContain('float frac');          // common.h 展开
    expect(pass.uniforms.get('g_Speed')).toBe(2.5);        // constantshadervalues 映射
    expect(pass.textureSlots).toEqual([null, 'masks/waterwaves_mask_e0eafd2b']);
  });
  it('无覆写时使用 default 值、textures 为空数组', async () => {
    const chain = await resolveEffectChain({ file: 'effects/waterwaves/effect.json' }, loadFile);
    const pass = chain![0];
    expect(pass.uniforms.get('g_Speed')).toBe(5);          // annotation.default
    expect(pass.textureSlots).toEqual([]);
  });
  it('effect 文件缺失返回 null', async () => {
    expect(await resolveEffectChain({ file: 'effects/missing/effect.json' }, loadFile)).toBeNull();
  });
  it('material 缺失返回 null', async () => {
    const chain = await resolveEffectChain({ file: 'effects/waterwaves/effect.json', passes: [{ material: 'x.json' }] }, loadFile);
    expect(chain).toBeNull();
  });
  it('内置 util 材质 pass（materials/util/*）跳过，保留后续真实 pass（refraction 链实测）', async () => {
    // 对应 2911105183 的 effects/refraction/effect.json：pass0 compose 引内置材质（pkg 无文件），
    // pass1 才是真实 refract shader——内置合成 pass 跳过，链仍可解析
    const fxFiles = new Map<string, Uint8Array>(files);
    fxFiles.set('effects/refraction/effect.json', encoder.encode(JSON.stringify({
      passes: [
        { material: 'materials/util/effectcomposebackground.json', compose: true },
        { material: 'materials/effects/refract.json' },
      ],
    })));
    fxFiles.set('materials/effects/refract.json', encoder.encode(JSON.stringify({
      passes: [{ shader: 'effects/refract', blending: 'normal' }],
    })));
    fxFiles.set('shaders/effects/refract.vert', encoder.encode('void main() { gl_Position = vec4(a_Position, 1.0); }'));
    fxFiles.set('shaders/effects/refract.frag', encoder.encode('void main() { gl_FragColor = vec4(1.0); }'));
    const load = async (name: string) => fxFiles.get(name) ?? null;
    const chain = await resolveEffectChain({
      file: 'effects/refraction/effect.json',
      passes: [{ id: 333 }, { constantshadervalues: { strength: 0.12 } }],
    }, load);
    expect(chain).not.toBeNull();
    expect(chain!.length).toBe(1); // 内置 compose pass 被跳过，只剩 refract
    expect(chain![0].fragSrc).toContain('gl_FragColor');
  });
  it('全部 pass 均为内置 util 材质 → 无可执行 pass，返回 null', async () => {
    const fxFiles = new Map<string, Uint8Array>(files);
    fxFiles.set('effects/composeonly/effect.json', encoder.encode(JSON.stringify({
      passes: [{ material: 'materials/util/effectcomposebackground.json', compose: true }],
    })));
    const load = async (name: string) => fxFiles.get(name) ?? null;
    expect(await resolveEffectChain({ file: 'effects/composeonly/effect.json' }, load)).toBeNull();
  });
});
