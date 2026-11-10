// 相机视差运行时：从 ThreeScenePlayer 拆出的第二个子系统（审查 P0-9 阶段 1）。
// 只依赖 three 与 parallax.js 的纯函数；背景/粒子条目按最小结构注入，不 import player（避免循环依赖）。
import * as THREE from 'three';
import { advancePointer, parallaxShift, POINTER_CENTER } from './parallax.js';
import type { ParallaxConfig, PointerFollow, PointerState } from './parallax.js';

/** 背景条目中视差用到的字段（结构兼容 player 内的 BackgroundEntry）。 */
export interface ParallaxBackgroundLike {
  origin: [number, number, number];
  sceneW: number;
  sceneH: number;
  align: [number, number];
  parallaxNode: THREE.Object3D;
  parallaxDepth?: [number, number];
  parallaxApplied?: boolean;
}

/** 粒子层中视差用到的字段（结构兼容 player 内的 ParticleLayer）。 */
export interface ParallaxParticleLike {
  parallaxCenter: [number, number];
  parallaxIsolated?: boolean;
  parallaxQuad?: THREE.Object3D;
  parallaxDepth?: [number, number];
  parallaxApplied?: boolean;
  material: { uniforms: Record<string, { value: unknown }> };
}

export interface ParallaxTickDeps {
  sceneWidth: number;
  sceneHeight: number;
  backgrounds: Iterable<ParallaxBackgroundLike>;
  particles: Iterable<ParallaxParticleLike>;
}

export class ParallaxRuntime {
  private cfg: ParallaxConfig | null = null;
  private target: PointerState = { ...POINTER_CENTER };
  private follow: PointerFollow = { value: { ...POINTER_CENTER }, elapsed: 0 };

  setConfig(cfg: ParallaxConfig | null): void {
    this.cfg = cfg;
  }

  setPointer(p: PointerState): void {
    this.target = p;
  }

  pointer(): PointerState {
    return this.follow.value;
  }

  // 逐帧：推进指针插值，并按 parallaxDepth 把**对象平移**写进各自的落点（非隔离 = mesh、
  // 隔离 = 合成 quad、粒子 = 顶点 shader 的 u_Parallax）。相机不动 —— 视差只是 model 平移。
  // ⚠️ 「不参与视差」（关视差 / depth 缺失 / depth 两根轴全 0）只写回**一次**基准位：每帧无条件写
  // position 会盖掉脚本对同一对象的 origin 写入（layer-state.applyLayerState 直接写 three 对象）
  // ⇒ 动态网格静止；而全库 34 张里只有 1 张开视差，其 pkg 内仍有 3 个对象的 depth 真值为全 0。
  tick(dt: number, deps: ParallaxTickDeps): void {
    const cfg = this.cfg;
    if (!cfg) return;
    this.follow = advancePointer(this.follow, this.target, cfg, dt);
    for (const entry of deps.backgrounds) {
      // 基准位 = 锚点 origin（we_to_three）+ alignment 偏移；视差 node 仍取**锚点原点**（alignment
      // 是局部几何偏移，不参与视差的 node 坐标，否则 shift 会随锚点额外平移）。
      const bx = entry.origin[0] - entry.sceneW / 2;
      const by = entry.origin[1] - entry.sceneH / 2;
      const x = bx + entry.align[0];
      const y = by + entry.align[1];
      const z = entry.origin[2];
      // depth 全 0（scene.json 里有真值 "0.00000 0.00000"）与缺省同义 = 不参与视差：shift 恒 0，
      // 但**写**这个动作本身会覆盖脚本位移，故必须归到「不写」分支。
      const d = entry.parallaxDepth;
      const depth = d && (d[0] !== 0 || d[1] !== 0) ? d : null;
      if (!cfg.enabled || !depth) {
        if (entry.parallaxApplied) {
          entry.parallaxNode.position.set(x, y, z);
          entry.parallaxApplied = false;
        }
        continue;
      }
      const [sx, sy] = parallaxShift({
        pointer: this.follow.value,
        // OWE 的 ortho 是**场景**正交尺寸（general.orthogonalprojection），不是窗口尺寸。
        orthoW: deps.sceneWidth,
        orthoH: deps.sceneHeight,
        nodeX: bx, nodeY: by,
        // three 坐标下主相机位于场景中心（we_to_three 已把中心移到原点）。
        camX: 0, camY: 0,
        depth,
        cfg,
      });
      entry.parallaxNode.position.set(x + sx, y + sy, z);
      entry.parallaxApplied = true;
    }
    // 粒子层：非隔离层把位移注入顶点 shader（= 对象局部的世界平移）；隔离层写合成 quad（在对象
    // RT 内平移会被 RT 边界裁掉）。
    for (const layer of deps.particles) {
      const [cx, cy] = layer.parallaxCenter;
      const u = (layer.material.uniforms as Record<string, { value: THREE.Vector2 }>).u_Parallax;
      // 隔离层的位移落点只有 quad：quad 意外缺失时跳过本层，**不得**退化写 u_Parallax（那正是会
      // 被 RT 边界裁掉的落点）。
      if (layer.parallaxIsolated && !layer.parallaxQuad) continue;
      const d = layer.parallaxDepth;
      const depth = d && (d[0] !== 0 || d[1] !== 0) ? d : null;
      if (!cfg.enabled || !depth) {
        if (layer.parallaxApplied) {
          if (layer.parallaxQuad) layer.parallaxQuad.position.set(cx, cy, layer.parallaxQuad.position.z);
          else u?.value.set(0, 0);
          layer.parallaxApplied = false;
        }
        continue;
      }
      const [sx, sy] = parallaxShift({
        pointer: this.follow.value,
        orthoW: deps.sceneWidth,
        orthoH: deps.sceneHeight,
        nodeX: cx, nodeY: cy,
        camX: 0, camY: 0,
        depth,
        cfg,
      });
      if (layer.parallaxQuad) layer.parallaxQuad.position.set(cx + sx, cy + sy, layer.parallaxQuad.position.z);
      else u?.value.set(sx, sy);
      layer.parallaxApplied = true;
    }
  }
}
