// src/client/effect-runner.ts
// 效果链执行器：逐链逐 pass 在 ping-pong RT 上执行 WE 后处理 shader。
// WebGL 部分无法在 node 测试，纯逻辑（RT 交替计划）导出为 rtAlternation 供单测。
import * as THREE from 'three';
import type { CompiledEffectPass } from './shader/effect-chain.js';
import { loadTexTexture } from './tex-loader.js';

export interface RtStep { passIndex: number; writeTo: 'A' | 'B' }

// 按链长度展开为 RT 交替计划：当前读端 A（输入），pass 写 B，下一 pass 读 B 写 A……
// 链之间的承接：上一链最终输出作为下一链输入（读端切换由执行器记录）。
export function rtAlternation(chainPassCounts: number[]): RtStep[] {
  const steps: RtStep[] = [];
  let acc = 0;
  for (const n of chainPassCounts) {
    for (let i = 0; i < n; i++) {
      steps.push({ passIndex: acc + i, writeTo: (acc + i) % 2 === 0 ? 'B' : 'A' });
    }
    acc += n;
  }
  return steps;
}

export class EffectRunner {
  private renderer: THREE.WebGLRenderer;
  private rtA: THREE.WebGLRenderTarget;
  private rtB: THREE.WebGLRenderTarget;
  private chains: CompiledEffectPass[][] = [];
  private id = '';
  private last: THREE.Texture | null = null;   // 最近一次 update 的最终输出（帧循环贴屏用）
  private materials = new Map<string, THREE.ShaderMaterial>();   // key: `${chainIdx}:${passIdx}`
  private scenes = new Map<string, THREE.Scene>();               // 每 pass 独立场景（含全屏 quad）
  private textures = new Map<string, THREE.Texture | null>();    // 纹理槽缓存（key: `${id}:${path}`）
  private width: number;
  private height: number;

  constructor(renderer: THREE.WebGLRenderer, width: number, height: number) {
    this.renderer = renderer;
    this.width = width;
    this.height = height;
    this.rtA = new THREE.WebGLRenderTarget(width, height);
    this.rtB = new THREE.WebGLRenderTarget(width, height);
  }

  setChains(chains: CompiledEffectPass[][], wallpaperId: string): void {
    this.chains = chains;
    this.id = wallpaperId;
    this.disposeMaterials();
  }

  private disposeMaterials(): void {
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
    this.scenes.clear();
  }

  private getMaterial(pass: CompiledEffectPass, key: string): THREE.ShaderMaterial | null {
    const cached = this.materials.get(key);
    if (cached) return cached;
    try {
      const uniforms: Record<string, THREE.IUniform> = {};
      for (const [name, value] of pass.uniforms) {
        uniforms[name] = { value: Array.isArray(value) ? value.slice() : value };
      }
      // 全屏 quad 在 NDC 下直接输出：模型/视图/投影矩阵取单位阵（WE 行主序 mul(v,M)=M*v）
      if (uniforms['g_ModelViewProjectionMatrix']) {
        uniforms['g_ModelViewProjectionMatrix'].value = new THREE.Matrix4();
      }
      const material = new THREE.ShaderMaterial({
        vertexShader: pass.vertSrc,
        fragmentShader: pass.fragSrc,
        uniforms,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        blending: blendModeToThree(pass.blendMode),
      });
      this.materials.set(key, material);
      return material;
    } catch (e) {
      console.warn('[wallpaper-engine] 效果 pass 编译失败，跳过:', key, e);
      return null;
    }
  }

  private getScene(key: string, material: THREE.ShaderMaterial): THREE.Scene {
    const cached = this.scenes.get(key);
    if (cached) return cached;
    const scene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    quad.frustumCulled = false;
    scene.add(quad);
    this.scenes.set(key, scene);
    return scene;
  }

  private async resolveTextureSlot(path: string | null): Promise<THREE.Texture | null> {
    if (!path) return null;
    const key = `${this.id}:${path}`;
    if (this.textures.has(key)) return this.textures.get(key) ?? null;
    const tex = await loadTexTexture(`/wallpapers/scene/${this.id}/asset?name=${encodeURIComponent(path)}`);
    if (!tex) console.warn('[wallpaper-engine] 纹理槽加载失败，跳过:', path);
    this.textures.set(key, tex);
    return tex;
  }

  async update(time: number, input: THREE.WebGLRenderTarget): Promise<THREE.WebGLRenderTarget> {
    const flat: CompiledEffectPass[] = this.chains.flat();
    if (flat.length === 0) return input;
    const steps = rtAlternation(this.chains.map((c) => c.length));
    const targets = { A: this.rtA, B: this.rtB } as const;
    let read = input;
    for (const step of steps) {
      const pass = flat[step.passIndex];
      const key = `${step.passIndex}`;
      const material = this.getMaterial(pass, key);
      if (!material) continue; // 编译失败 → 跳过该 pass（画面保持上一状态）
      // 纹理槽：textures[i] → g_Texture(i+1)；g_Texture0 由执行器设为读端
      for (let i = 0; i < pass.textureSlots.length; i++) {
        const tex = await this.resolveTextureSlot(pass.textureSlots[i]);
        const slot = `g_Texture${i + 1}`;
        if (material.uniforms[slot]) material.uniforms[slot].value = tex;
        const res = `g_Texture${i + 1}Resolution`;
        if (material.uniforms[res]) {
          const w = (tex?.image as { width?: number } | undefined)?.width ?? this.width;
          const h = (tex?.image as { height?: number } | undefined)?.height ?? this.height;
          material.uniforms[res].value = new THREE.Vector4(w, h, 1 / Math.max(1, w), 1 / Math.max(1, h));
        }
      }
      if (material.uniforms['g_Texture0']) material.uniforms['g_Texture0'].value = read.texture;
      if (material.uniforms['g_Time']) material.uniforms['g_Time'].value = time;
      const writeTarget = targets[step.writeTo];
      this.renderer.setRenderTarget(writeTarget);
      this.renderer.render(this.getScene(key, material), SCREEN_CAMERA);
      read = writeTarget;
    }
    this.renderer.setRenderTarget(null);
    this.last = read.texture; // 同步记录最终输出（帧循环经 lastOutput 贴屏，避免异步竞态）
    return read;
  }

  // 帧循环同步读取最近输出：update 未完成时返回 null（调用方回退场景 RT，避免首帧黑屏）
  lastOutput(): THREE.Texture | null {
    return this.last;
  }

  dispose(): void {
    this.disposeMaterials();
    this.rtA.dispose();
    this.rtB.dispose();
    this.textures.clear();
  }
}

// 全屏后处理相机：NDC 正交（PlaneGeometry(2,2) 铺满视口）
const SCREEN_CAMERA = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
SCREEN_CAMERA.position.z = 300;

// 材质 json blending → three 混合模式（WE 枚举，spec §3.2；未知回退 normal）
export function blendModeToThree(mode: string): THREE.Blending {
  switch (mode) {
    case 'add': return THREE.AdditiveBlending;
    case 'multiply': return THREE.MultiplyBlending;
    case 'subtract': return THREE.SubtractiveBlending;
    default: return THREE.NormalBlending;
  }
}
