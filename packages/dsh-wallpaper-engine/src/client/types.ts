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
}
