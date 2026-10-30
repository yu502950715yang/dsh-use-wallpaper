// host 媒体会话：Windows SMTC（GlobalSystemMediaTransportControlsSessionManager）。
// 进程常驻、懒启动、空闲退出；title/artist 仅内存，不落盘不写日志。
import type { MediaPlaybackState, MediaReason } from '../shared/media.js';

export interface RawMediaSession {
  appId: string; status: string; title: string; artist: string; album: string; contentType: string;
  positionMs: number; durationMs: number;
  art: { bytes: Buffer; contentType: string } | null;
}
export interface WatcherFrame { at: number; sessions: RawMediaSession[] }

export function playbackOfStatus(status: string): MediaPlaybackState {
  if (status === 'Playing') return 'playing';
  if (status === 'Paused') return 'paused';
  return 'stopped';
}

// 会话签名（不含 position/art 字节）：用于 lastChangedAt 与封面重取判定。
function sessionSignature(s: RawMediaSession): string {
  return [s.appId, s.title, s.artist, s.album, s.contentType, s.status].join('\u0001');
}

export function parseWatcherLine(line: string): WatcherFrame | null {
  let raw: unknown;
  try { raw = JSON.parse(String(line).trim()); } catch { return null; }
  const o = raw as { v?: unknown; at?: unknown; sessions?: unknown };
  if (!o || o.v !== 1 || typeof o.at !== 'number' || !Array.isArray(o.sessions)) return null;
  const sessions: RawMediaSession[] = [];
  for (const item of o.sessions) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const appId = typeof r.appId === 'string' ? r.appId : '';
    const title = typeof r.title === 'string' ? r.title : '';
    if (!appId && !title) continue;
    let art: RawMediaSession['art'] = null;
    if (typeof r.artB64 === 'string' && r.artB64) {
      try {
        const bytes = Buffer.from(r.artB64, 'base64');
        if (bytes.length > 0 && bytes.length <= 512 * 1024) {
          art = { bytes, contentType: typeof r.artType === 'string' && r.artType ? r.artType : 'image/png' };
        }
      } catch { art = null; }
    }
    sessions.push({
      appId, status: typeof r.status === 'string' ? r.status : '',
      title, artist: typeof r.artist === 'string' ? r.artist : '',
      album: typeof r.album === 'string' ? r.album : '',
      contentType: typeof r.contentType === 'string' ? r.contentType : '',
      positionMs: typeof r.positionMs === 'number' ? r.positionMs : 0,
      durationMs: typeof r.durationMs === 'number' ? r.durationMs : 0,
      art,
    });
  }
  return { at: o.at, sessions };
}

export interface SessionSelectionOptions { ownAppId: string; pageTitle: string; lastChangedAt: ReadonlyMap<string, number> }

// 选择规则（spec §4.3）：剔除自身/页面标题/空标题 → playing > paused → artist 非空 → lastChangedAt 最新。
export function selectSession(frame: WatcherFrame, opts: SessionSelectionOptions): { session: RawMediaSession | null; reason: MediaReason } {
  const candidates = frame.sessions.filter((s) => {
    if (!s.title) return false;
    if (opts.ownAppId && s.appId === opts.ownAppId) return false;
    if (opts.pageTitle && s.title === opts.pageTitle) return false;
    return playbackOfStatus(s.status) !== 'stopped';
  });
  if (candidates.length === 0) return { session: null, reason: 'no-session' };
  const rank = (s: RawMediaSession) => [
    playbackOfStatus(s.status) === 'playing' ? 1 : 0,
    s.artist ? 1 : 0,
    opts.lastChangedAt.get(s.appId) ?? 0,
  ];
  candidates.sort((a, b) => {
    const ra = rank(a), rb = rank(b);
    for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return rb[i]! - ra[i]!;
    return 0;
  });
  return { session: candidates[0]!, reason: 'ok' };
}

// 常驻 watcher 的 PowerShell 脚本（常量，不拼接运行期数据）。
// 每 700ms 全量采样；只在会话签名变化时输出一行 JSON（封面仅签名变化时携带）。
export const WATCH_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1" })[0]',
  'function Await($op, $type) { $m = $asTask.MakeGenericMethod($type); $t = $m.Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
  '$mgr = Await ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
  '$last = ""',
  '$lastArt = @{}',
  'while ($true) {',
  '  $list = @()',
  '  $sigParts = @()',
  '  foreach ($s in $mgr.GetSessions()) {',
  '    $pi = $s.GetPlaybackInfo()',
  '    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])',
  '    $tl = $s.GetTimelineProperties()',
  '    $appId = [string]$s.SourceAppUserModelId',
  '    $title = [string]$p.Title',
  '    $artist = [string]$p.Artist',
  '    $sig = "$appId|$title|$artist|$([string]$pi.PlaybackStatus)"',
  '    $sigParts += $sig',
  '    $artB64 = ""',
  '    $artType = ""',
  '    if ($lastArt[$appId] -ne $sig) {',
  '      try {',
  '        if ($null -ne $p.Thumbnail) {',
  '          $st = Await ($p.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])',
  '          $n = [uint32]$st.Size',
  '          if ($n -gt 0 -and $n -le 524288) {',
  '            $rd = [Windows.Storage.Streams.DataReader]::new($st)',
  '            Await ($rd.LoadAsync($n)) ([uint32]) | Out-Null',
  '            $buf = New-Object byte[] $n',
  '            $rd.ReadBytes($buf)',
  '            $artB64 = [Convert]::ToBase64String($buf)',
  '            $artType = [string]$st.ContentType',
  '          }',
  '        }',
  '      } catch { $artB64 = "" }',
  '      $lastArt[$appId] = $sig',
  '    }',
  '    $list += [ordered]@{ appId = $appId; status = [string]$pi.PlaybackStatus; title = $title; artist = $artist; album = [string]$p.AlbumTitle; contentType = [string]$p.ContentType; positionMs = [double]$tl.Position.TotalMilliseconds; durationMs = [double]$tl.EndTime.TotalMilliseconds; artB64 = $artB64; artType = $artType }',
  '  }',
  '  $signature = $sigParts -join "||"',
  '  if ($signature -ne $last -or $last -eq "") {',
  '    $last = $signature',
  '    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ v = 1; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sessions = $list })))',
  '    [Console]::Out.Flush()',
  '  }',
  '  Start-Sleep -Milliseconds 700',
  '}',
].join('\n');
