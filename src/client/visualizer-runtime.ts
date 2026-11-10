// 音频可视化条运行时：从 ThreeScenePlayer 拆出的阶段 2 子系统（审查 P0-9）。
// 依赖宿主注入 addBackground/entryMesh（条本身就是背景图层），不 import player。
import * as THREE from 'three';

export interface VisualizerBarsOpts {
  origin: [number, number, number];
  barSize: [number, number];
  texture?: THREE.Texture;
  barWidth: number;
  scaleY: number;
  originX: number;
  sceneW: number;
  sceneH: number;
  renderOrder?: number;
  count?: number;
}

export interface PixelVisualizerBarsOpts {
  origin: [number, number, number];
  scale: [number, number, number];
  angles: [number, number, number];
  barSize: [number, number];
  barWidth: number;
  minBarHeight: number;
  scaleY: number;
  barPath: string;
  downscaleMode: 'max' | 'average';
  sceneW: number;
  sceneH: number;
  renderOrder?: number;
  count: number;
  alignment?: string;
  texture?: THREE.Texture;
}

/** addBackground 的最小参数面（结构兼容 player 的 addBackground）。 */
export interface VisualizerAddOpts {
  origin: [number, number, number];
  size: [number, number];
  scale: [number, number, number];
  angles?: [number, number, number];
  alignment?: string;
  texture?: THREE.Texture;
  sceneW: number;
  sceneH: number;
  renderOrder?: number;
}

export interface VisualizerHost {
  addBackground(opts: VisualizerAddOpts): number;
  entryMesh(id: number): THREE.Mesh | undefined;
}

type Bar = { id: number; baseY: number; barSizeH: number; scaleY: number };
type PixelBar = {
  id: number;
  barSizeH: number;
  minBarHeight: number;
  objScaleY: number;
  downscaleMode: 'max' | 'average';
  count: number;
};

export class VisualizerRuntime {
  private bars: Bar[] = [];
  private pixelBars: PixelBar[] = [];

  constructor(private readonly host: VisualizerHost) {}

  /** SceneScript 的 64 条音频条：按 origin 横向排布，barWidth 为世界宽度、初始高度 0。 */
  setBars(opts: VisualizerBarsOpts): number[] {
    const count = opts.count ?? 64;
    const ids: number[] = [];
    this.bars = [];
    for (let i = 0; i < count; i++) {
      const id = this.host.addBackground({
        origin: [opts.origin[0] + i * opts.originX, opts.origin[1], opts.origin[2]],
        size: [opts.barSize[0], opts.barSize[1]],
        // 初始高度 0（无音频时不可见）；宽度按脚本 barWidth。
        scale: [opts.barWidth, 0, 1],
        texture: opts.texture,
        sceneW: opts.sceneW,
        sceneH: opts.sceneH,
        renderOrder: (opts.renderOrder ?? 0) + i + 1,
      });
      ids.push(id);
      this.bars.push({
        id, baseY: opts.origin[1] - opts.sceneH / 2, barSizeH: opts.barSize[1], scaleY: opts.scaleY,
      });
    }
    return ids;
  }

  /**
   * 自定义 visualizer（pixel-bars 家族，如 3118949804）：按对象 scale/angles 布局 count 条；
   * 高度倍率默认 minBarHeight（静音仍可见，与脚本 Math.max(minBarHeight, …) 一致）。
   */
  setPixelBars(opts: PixelVisualizerBarsOpts): number[] {
    const ids: number[] = [];
    this.pixelBars = [];
    const sx = opts.scale[0];
    const [, ay, az] = opts.angles;
    const halfBarWidth = sx / opts.count / 2;
    const cosAz = Math.cos(az), sinAz = Math.sin(az);
    const cosAy = Math.cos(ay), sinAy = Math.sin(ay);
    for (let i = 0; i < opts.count; i++) {
      // 脚本布局：x = scale.x × (i/count) − scale.x/2 + halfBarWidth，再按对象 angles 旋转到世界。
      const localX = sx * (i / opts.count) - sx / 2 + halfBarWidth;
      const rx = localX * cosAy * cosAz;
      const ry = localX * cosAy * sinAz;
      const rz = localX * -sinAy;
      const id = this.host.addBackground({
        origin: [opts.origin[0] + rx, opts.origin[1] + ry, opts.origin[2] + rz],
        size: [opts.barSize[0], opts.barSize[1]],
        scale: [opts.barWidth, opts.minBarHeight, 1],
        angles: opts.angles,
        alignment: opts.alignment,
        texture: opts.texture,
        sceneW: opts.sceneW,
        sceneH: opts.sceneH,
        renderOrder: (opts.renderOrder ?? 0) + i + 1,
      });
      ids.push(id);
      this.pixelBars.push({
        id,
        barSizeH: opts.barSize[1],
        minBarHeight: opts.minBarHeight,
        objScaleY: opts.scaleY,
        downscaleMode: opts.downscaleMode,
        count: opts.count,
      });
    }
    return ids;
  }

  /** 每帧更新可视化条高度：freqData = 64 bin 频谱（0-255）；null = 无音频 → 全部归零。 */
  update(freqData: Uint8Array | null): void {
    for (let i = 0; i < this.bars.length; i++) {
      const bar = this.bars[i];
      const mesh = this.host.entryMesh(bar.id);
      if (!mesh) continue;
      const bin = freqData && i < freqData.length ? freqData[i] / 255 : 0;
      const h = bar.barSizeH * Math.max(0, Math.min(1, bin)) * bar.scaleY;
      mesh.scale.y = h / bar.barSizeH;
      // bottom 对齐：条底部固定在 origin.y（脚本 barAlignmentdir='bottom'）。
      mesh.position.y = bar.baseY + h / 2;
    }
    // pixel-bars：脚本公式 max(minBarHeight, audio × 对象 scale.y × 0.25)；无音频回到 minBarHeight。
    for (let i = 0; i < this.pixelBars.length; i++) {
      const bar = this.pixelBars[i];
      const mesh = this.host.entryMesh(bar.id);
      if (!mesh) continue;
      const span = 64 / bar.count;
      const start = Math.floor(i * span);
      const end = Math.min(64, Math.max(start + 1, Math.floor((i + 1) * span)));
      let audio = 0;
      if (freqData) {
        const vals: number[] = [];
        for (let p = start; p < end; p++) vals.push((freqData[p] ?? 0) / 255);
        audio = bar.downscaleMode === 'average' ? vals.reduce((a, b) => a + b, 0) / vals.length : Math.max(0, ...vals);
      }
      mesh.scale.y = Math.max(bar.minBarHeight, audio * bar.objScaleY * 0.25);
    }
  }
}
