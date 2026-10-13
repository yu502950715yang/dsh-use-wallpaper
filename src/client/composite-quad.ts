// src/client/composite-quad.ts
// 单职责：把一张给定纹理**全屏**贴到当前 render target（段渲染末段的合成步）。
// 语义对齐 glow-stage 的 composite：只做恒等拷贝，不引入任何颜色空间转换（见 glow-stage 文件头前提）。
import * as THREE from 'three';

export interface CompositeQuad {
  /** 把 texture 全屏贴到**当前绑定的** render target（不切 target，不读 canvas 尺寸）。 */
  composite(renderer: THREE.WebGLRenderer, texture: THREE.Texture): void;
  /** 画布缓冲尺寸变化时的钩子（几何是固定 NDC 尺寸，目前只做空实现，保持接口稳定）。 */
  resize(width: number, height: number): void;
  /** 释放自持的几何/材质（纹理所有权在调用方，不在此 dispose）。 */
  dispose(): void;
}

// 固定 NDC 全屏四边形（position ∈ [-1,1]²，uv ∈ [0,1]²）：不随视口重建。
const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// 恒等拷贝 + alpha 恒 1：与 glow-stage 的 composite 同口径（画布缓冲本来就不透明，
// 写真实 alpha 只会让「有消费者」的画面在合成这一步出现无谓差异）。
const FRAG = `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, 1.0);
}
`;

export function createCompositeQuad(renderer: THREE.WebGLRenderer): CompositeQuad {
  const geometry = new THREE.PlaneGeometry(2, 2);
  // 正交相机直视 quad：near/far 取 ±1 保证 z=0 在视锥内（不参与深度，仅保证不被裁掉）。
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms: { tSrc: { value: null } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    depthTest: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false; // NDC quad 的包围球与主相机无关，必须显式关剔除
  const scene = new THREE.Scene();
  scene.add(mesh);
  let disposed = false;

  return {
    composite(r, texture) {
      if (disposed) return;
      material.uniforms.tSrc.value = texture;
      r.render(scene, camera);
    },
    resize() {
      // 空实现：几何是固定 NDC 尺寸，与画布像素无关（保留接口以备将来半分辨率优化）。
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      geometry.dispose();
      material.dispose();
      scene.remove(mesh);
    },
  };
}
