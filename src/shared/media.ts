// 媒体集成共享类型（host ↔ client）：纯类型/纯函数，架构守卫允许两端共用。
export type MediaPlaybackState = 'stopped' | 'playing' | 'paused';
export type MediaReason = 'ok' | 'no-session' | 'disabled' | 'unsupported-platform' | 'no-powershell' | 'watcher-failed';
export type MediaRgb = [number, number, number];

export interface MediaSessionSnapshot {
  available: boolean; reason: MediaReason;
  appId: string; title: string; artist: string; album: string; contentType: string;
  playback: MediaPlaybackState; hasThumbnail: boolean; thumbnailRev: number;
  positionMs: number | null; durationMs: number | null; at: number;
}

/** 面板只读的媒体集成状态：不含 title/artist/album/封面等隐私字段。 */
export interface MediaIntegrationStatus {
  available: boolean;
  reason: MediaReason;
  enabled: boolean;
}

export interface MediaPalette {
  primary: MediaRgb; secondary: MediaRgb; tertiary: MediaRgb; text: MediaRgb; highContrast: MediaRgb;
}

/** WE image 实例的系统用户纹理名：取当前播放封面（scene.json instance.usertextures）。 */
export const MEDIA_THUMBNAIL_TEXTURE = '$mediaThumbnail';

/** SceneScript 媒体事件 / 文本脚本共用的曲目元数据。 */
export interface MediaPropertiesPayload {
  title: string;
  artist: string;
  album: string;
  contentType: string;
}

/** 中性快照：所有失败/无会话路径共用（available=false ⇒ 客户端派发 stopped）。 */
export function emptyMediaSnapshot(reason: MediaReason, at = 0): MediaSessionSnapshot {
  return {
    available: false, reason, appId: '', title: '', artist: '', album: '', contentType: '',
    playback: 'stopped', hasThumbnail: false, thumbnailRev: 0, positionMs: null, durationMs: null, at,
  };
}
