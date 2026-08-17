export type BackgroundPlan =
  | { kind: 'image'; url: string; kenBurns: boolean }
  | { kind: 'video'; url: string }
  | { kind: 'scene'; wallpaperId: string }
  | { kind: 'none' };

export interface ClientSettings {
  selectedWallpaperId: string;
  overlayOpacity: number;
  blurEnabled: boolean;
  blurRadius: number;
  kenBurns: boolean;
}
