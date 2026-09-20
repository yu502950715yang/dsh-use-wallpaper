export type BackgroundPlan =
  | { kind: 'image'; url: string; kenBurns: boolean }
  | { kind: 'video'; url: string }
  | { kind: 'scene'; wallpaperId: string }
  | { kind: 'web'; url: string }
  | { kind: 'none' };

export interface ClientSettings {
  selectedWallpaperId: string;
  // 壁纸目录与引擎目录（空 = 未配置，回退 config/缺省）；设置面板可写
  wallpaperDir: string;
  weAssetsDir: string;
  overlayOpacity: number;
  blurEnabled: boolean;
  blurRadius: number;
  kenBurns: boolean;
  /** 应用级 Glow（对齐 WE 的 general.user.postprocessing）：整帧亮部发光。 */
  glowEnabled: boolean;
  /** bright-pass 阈值（sRGB 域），缺省 0.65。 */
  glowThreshold: number;
  /** 发光强度，缺省 1.0。 */
  glowStrength: number;
}
