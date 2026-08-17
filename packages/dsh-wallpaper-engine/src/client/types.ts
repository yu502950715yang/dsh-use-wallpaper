export type BackgroundPlan =
  | { kind: 'image'; url: string; kenBurns: boolean }
  | { kind: 'video'; url: string }
  | { kind: 'scene'; wallpaperId: string }
  | { kind: 'none' };
