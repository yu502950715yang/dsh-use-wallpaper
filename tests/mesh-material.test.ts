import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseMeshMaterial, createMeshMaterial } from '../src/client/mesh-material.js';
import { PARTICLE_MESH_VERT } from '../src/client/mesh-shaders.js';

// ⚠️ 回归（2026-09-22 真机）：attribute 名写成 WE 的 a_Position/a_TexCoord 时，three 是按名字绑定
// geometry attribute 的 ⇒ 一个都绑不上、顶点恒 0、画面空白且**不报错**（e2e 变化只有 0.02% 才发现）。
describe('PARTICLE_MESH_VERT 必须用 three 的 built-in 接口', () => {
  it('attribute 用 position/uv，变换用内建矩阵', () => {
    expect(PARTICLE_MESH_VERT).toContain('position');
    expect(PARTICLE_MESH_VERT).toContain('projectionMatrix');
    expect(PARTICLE_MESH_VERT).toContain('modelViewMatrix');
    expect(PARTICLE_MESH_VERT).not.toContain('a_Position');
    expect(PARTICLE_MESH_VERT).not.toContain('a_TexCoord');
    expect(PARTICLE_MESH_VERT).not.toContain('g_ModelViewProjectionMatrix');
  });

  it('color 为 vec4 且显式声明（three 只在自己开 vertexColors 时注入 vec3 color）', () => {
    expect(PARTICLE_MESH_VERT).toContain('attribute vec4 color');
  });
});

describe('parseMeshMaterial', () => {
  it('解析 additive 粒子材质（3798688689 的真实形状）', () => {
    const spec = parseMeshMaterial(JSON.stringify({
      passes: [{ shader: 'we2d_particle_mesh', textures: ['source/a_4b7892c81030'], blending: 'additive',
                 cullmode: 0, depthtest: false, depthwrite: false }],
    }))!;
    expect(spec.shader).toBe('we2d_particle_mesh');
    expect(spec.texturePath).toBe('source/a_4b7892c81030');
    expect(spec.blending).toBe('additive');
    expect(spec.depthTest).toBe(false);
    expect(spec.depthWrite).toBe(false);
  });

  it('translucent → normal 混合；缺字段用安全默认', () => {
    const spec = parseMeshMaterial(JSON.stringify({ passes: [{ shader: 'x', textures: [], blending: 'translucent' }] }))!;
    expect(spec.blending).toBe('normal');
    expect(spec.texturePath).toBeNull();
    expect(spec.depthTest).toBe(true);
  });

  it('空/畸形 json → null（调用方回退白图兜底材质）', () => {
    expect(parseMeshMaterial('')).toBeNull();
    expect(parseMeshMaterial('{}')).toBeNull();
    expect(parseMeshMaterial('not json')).toBeNull();
    expect(parseMeshMaterial(JSON.stringify({ passes: [] }))).toBeNull();
  });
});

describe('createMeshMaterial', () => {
  it('additive → AdditiveBlending，且 depthWrite=false', () => {
    const spec = parseMeshMaterial(JSON.stringify({ passes: [{ shader: 'we2d_particle_mesh', textures: ['t'], blending: 'additive', depthwrite: false }] }))!;
    const mat = createMeshMaterial(spec, null) as THREE.ShaderMaterial;
    expect(mat.blending).toBe(THREE.AdditiveBlending);
    expect(mat.depthWrite).toBe(false);
    expect(mat.uniforms.g_Texture0).toBeTruthy();
  });

  it('spec 为 null → 白图兜底材质（不抛）', () => {
    const mat = createMeshMaterial(null, null);
    expect(mat).toBeInstanceOf(THREE.ShaderMaterial);
    expect((mat as THREE.ShaderMaterial).blending).toBe(THREE.AdditiveBlending);
  });

  it('alpha 层 shader 名走 alpha frag；其余走颜色层', () => {
    const alpha = createMeshMaterial({ shader: 'we2d_particle_alpha', texturePath: null, blending: 'additive', side: THREE.DoubleSide, depthTest: true, depthWrite: false }, null) as THREE.ShaderMaterial;
    const color = createMeshMaterial({ shader: 'we2d_particle_mesh', texturePath: null, blending: 'additive', side: THREE.DoubleSide, depthTest: true, depthWrite: false }, null) as THREE.ShaderMaterial;
    expect(alpha.fragmentShader).not.toBe(color.fragmentShader);
  });
});
