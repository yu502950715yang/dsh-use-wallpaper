// util 层内容运行时：从 ThreeScenePlayer 拆出的阶段 2 子系统（审查 P0-9）。
// 负责「数据面」：内容条目登记、快照纹理/覆盖矩形写入与测试观测；RT 重渲（renderUtilContent）留在
// player（依赖隔离条目与 renderer），保持本模块无渲染器依赖。
import * as THREE from 'three';
import { coverRange } from './object-range.js';

// util 层内容输入（整帧快照）在内容 mesh UV 空间的覆盖矩形：快照贴到哪块 UV（可越界/含镜像负值）。
export interface UtilContentCover {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

export interface UtilContentHostView {
  sceneWidth: number;
  sceneHeight: number;
  viewWidth: number;
  viewHeight: number;
}

const FULL_UV_COVER: UtilContentCover = { sx: 0, sy: 0, sw: 1, sh: 1 };

function sameCover(a: UtilContentCover, b: UtilContentCover): boolean {
  return a.sx === b.sx && a.sy === b.sy && a.sw === b.sw && a.sh === b.sh;
}

// util 层内容输入条目：段边界把整帧快照写成内容 → 效果链从「本帧画面」开始处理。
interface UtilContentEntry {
  mesh: THREE.Mesh;
  /** 内容几何基准 UV（未变换）：覆盖矩形变化时据此重写 UV，避免逐次累积。 */
  baseUv: Float32Array;
  /** 快照在内容 mesh UV 空间的覆盖矩形（= 当前生效值）。 */
  cover: UtilContentCover;
  texture: THREE.Texture | null;
  /** 内容世界矩形中心（场景坐标系，原点 = 场景中心；与合成 quad 同位置）。 */
  centerX: number;
  centerY: number;
}

export class UtilContentRuntime {
  private readonly entries = new Map<number, UtilContentEntry>();

  /** 登记 util 内容条目（内容 mesh 与快照内容区域的世界锚点）；solid 不登记（纯色内容不被替换）。 */
  register(objectId: number, mesh: THREE.Mesh, centerX: number, centerY: number): void {
    const uv = mesh.geometry.attributes?.uv;
    if (!uv) return;
    this.entries.set(objectId, {
      mesh,
      baseUv: Float32Array.from(uv.array as ArrayLike<number>),
      cover: FULL_UV_COVER,
      texture: null,
      centerX,
      centerY,
    });
  }

  setTexture(objectId: number, texture: THREE.Texture, opts: { cover?: UtilContentCover } = {}): void {
    const entry = this.entries.get(objectId);
    if (!entry) return;
    const material = entry.mesh.material as THREE.MeshBasicMaterial;
    let changed = false;
    if (material.map !== texture) {
      material.map = texture;
      material.opacity = 1; // 透明占位 → 快照内容
      material.needsUpdate = true; // 无 map → 有 map：需重编 program（每次装配仅一次）
      entry.texture = texture;
      changed = true;
    }
    const cover = opts.cover ?? FULL_UV_COVER;
    if (changed || !sameCover(entry.cover, cover)) this.applyCover(entry, cover);
  }

  /** 测试/诊断：util 内容当前纹理；solid / 非 util → null。 */
  textureForTest(objectId: number): THREE.Texture | null {
    return this.entries.get(objectId)?.texture ?? null;
  }

  /** 测试/诊断：util 内容当前的快照覆盖矩形（内容 mesh UV 空间）。 */
  uvForTest(objectId: number): UtilContentCover | null {
    const cover = this.entries.get(objectId)?.cover;
    return cover ? { ...cover } : null;
  }

  has(objectId: number): boolean {
    return this.entries.has(objectId);
  }

  clear(): void {
    this.entries.clear();
  }

  // 快照覆盖矩形 = 主相机 cover 视锥（世界，中心 = 场景中心，与 applyCover 同源）在内容 mesh
  // UV 空间的反解：u_tex = (u - sx)/sw。世界尺寸取**当前** mesh.scale × 几何（含镜像负值）。
  coverFor(objectId: number, view: UtilContentHostView): UtilContentCover | null {
    const entry = this.entries.get(objectId);
    if (!entry) return null;
    const geometry = entry.mesh.geometry as THREE.PlaneGeometry;
    const gw = geometry.parameters?.width ?? 0;
    const gh = geometry.parameters?.height ?? 0;
    const worldW = entry.mesh.scale.x * gw;
    const worldH = entry.mesh.scale.y * gh;
    if (!(Math.abs(worldW) > 1e-6) || !(Math.abs(worldH) > 1e-6)) return null;
    const cover = coverRange(view.sceneWidth, view.sceneHeight, view.viewWidth / view.viewHeight);
    const left = entry.centerX - worldW / 2;
    const bottom = entry.centerY - worldH / 2;
    return {
      sx: (-cover.w / 2 - left) / worldW,
      sy: (-cover.h / 2 - bottom) / worldH,
      sw: cover.w / worldW,
      sh: cover.h / worldH,
    };
  }

  // 按覆盖矩形重写内容几何 UV（uv' = (uv - sx)/sw）：v=0 = 画面底 ⇒ 快照 v 约定不额外翻转。
  private applyCover(entry: UtilContentEntry, cover: UtilContentCover): void {
    entry.cover = cover;
    const uv = entry.mesh.geometry.attributes?.uv;
    if (!uv) return;
    const arr = uv.array as Float32Array;
    const rx = 1 / cover.sw;
    const ry = 1 / cover.sh;
    const ox = -cover.sx / cover.sw;
    const oy = -cover.sy / cover.sh;
    for (let i = 0; i < arr.length && i < entry.baseUv.length; i += 2) {
      arr[i] = entry.baseUv[i] * rx + ox;
      arr[i + 1] = entry.baseUv[i + 1] * ry + oy;
    }
    uv.needsUpdate = true;
  }
}
