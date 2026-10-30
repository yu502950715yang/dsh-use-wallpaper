// host 媒体会话：Windows SMTC（GlobalSystemMediaTransportControlsSessionManager）。
// 进程常驻、懒启动、空闲退出；title/artist 仅内存，不落盘不写日志。
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { emptyMediaSnapshot, type MediaPlaybackState, type MediaReason, type MediaSessionSnapshot } from '../shared/media.js';

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
// 每 700ms 全量采样；只在会话签名变化时输出一行 JSON（封面仅在元数据变化时携带）。
export const WATCH_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null',
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation``1" })[0]',
  'function Await($op, $type) { $m = $asTask.MakeGenericMethod($type); $t = $m.Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }',
  '$mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]',
  '$mgr = Await ($mgrType::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])',
  '$last = ""',
  '$initialized = $false',
  '$lastArt = @{}',
  '$artDirty = $false',
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
  '    $album = [string]$p.AlbumTitle',
  '    $contentType = [string]$p.ContentType',
  '    $status = [string]$pi.PlaybackStatus',
  '    $sig = "$appId|$title|$artist|$album|$contentType|$status"',
  '    $artSig = "$appId|$title|$artist|$album|$contentType"',
  '    $sigParts += $sig',
  '    $artB64 = ""',
  '    $artType = ""',
  '    if ($lastArt[$appId] -ne $artSig) {',
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
  '            $lastArt[$appId] = $artSig',
  '            $artDirty = $true',
  '          }',
  '        }',
  '      } catch { $artB64 = "" }',
  '    }',
  '    $list += [ordered]@{ appId = $appId; status = $status; title = $title; artist = $artist; album = $album; contentType = $contentType; positionMs = [double]$tl.Position.TotalMilliseconds; durationMs = [double]$tl.EndTime.TotalMilliseconds; artB64 = $artB64; artType = $artType }',
  '  }',
  '  $signature = $sigParts -join "||"',
  '  if (-not $initialized -or $signature -ne $last -or $artDirty) {',
  '    $last = $signature',
  '    $initialized = $true',
  '    $artDirty = $false',
  '    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ v = 1; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sessions = $list })))',
  '    [Console]::Out.Flush()',
  '  }',
  '  Start-Sleep -Milliseconds 700',
  '}',
].join('\n');

// ── 常驻服务：进程生命周期 + 快照 + 封面缓存 ─────────────────────────────────

export interface MediaWatcherProcess {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  kill(): void;
  on(event: 'exit', cb: (code?: number | null) => void): void;
  // Node 对 ENOENT/EACCES 抛异步 error 事件；不监听会 uncaught。
  on(event: 'error', cb: (err?: unknown) => void): void;
}
export interface MediaSessionServiceOptions {
  platform?: NodeJS.Platform;
  spawnImpl?: (cmd: string, args: string[]) => MediaWatcherProcess;
  now?: () => number;
  ownAppId?: string;
  log?: (msg: string) => void;
  idleMs?: number;
  idleCheckMs?: number;
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (h: unknown) => void;
}
export interface MediaSessionService {
  request(opts: { pageTitle: string; enabled: boolean }): MediaSessionSnapshot;
  thumbnail(rev: number): { bytes: Buffer; contentType: string } | null;
  dispose(): void;
  stats(): { starts: number; badLines: number; restarts: number; degraded: boolean };
}

const DEFAULT_IDLE_MS = 20_000;
const DEFAULT_IDLE_CHECK_MS = 5_000;
const MAX_ART_BYTES = 512 * 1024;
const ART_CACHE_MAX = 8;
// spawn 异步失败后短退避：窗口内不重复 spawn，窗口外允许重试。
const START_RETRY_MS = 5_000;
const FAILURE_WINDOW_MS = 60_000;
const DEGRADE_MS = 60_000;

interface ArtEntry { bytes: Buffer; contentType: string; rev: number }

// 封面按会话存：同一会话后续状态变化行不再带 art，不能只记全局「最近一份」。
const sessionKeyOf = (s: Pick<RawMediaSession, 'appId' | 'title' | 'artist'>) =>
  [s.appId, s.title, s.artist].join('\u0001');

export function createMediaSessionService(opts: MediaSessionServiceOptions = {}): MediaSessionService {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const ownAppId = opts.ownAppId ?? '';
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const idleCheckMs = opts.idleCheckMs ?? DEFAULT_IDLE_CHECK_MS;
  const setIntervalImpl = opts.setIntervalImpl ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clearIntervalImpl = opts.clearIntervalImpl ?? ((h: unknown) => { clearInterval(h as NodeJS.Timeout); });
  const spawnWatcher = opts.spawnImpl ?? ((cmd: string, args: string[]) =>
    spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) as unknown as MediaWatcherProcess);

  let proc: MediaWatcherProcess | null = null;
  let buffer = '';
  // stdout 是字节流：多字节字符可能跨 chunk，必须用 StringDecoder 累积解码（逐 chunk toString 会出 U+FFFD）。
  let decoder = new StringDecoder('utf8');
  let frame: WatcherFrame | null = null;
  let lastRequestAt = 0;
  // 全局单调、stop 不重置：客户端以 rev 为缓存键，回退会显示错封面。
  let rev = 0;
  // 单一数据源：sessionKey → art（含 rev）。thumbnail 直接在此按 rev 查找。
  const artBySession = new Map<string, ArtEntry>();
  const lastChangedAt = new Map<string, number>();
  const sessionSig = new Map<string, string>();
  let idleTimer: unknown = null;
  let starts = 0;
  let restarts = 0;
  let badLines = 0;
  let degradedUntil = 0;
  let recentStartFailures: number[] = [];
  let lastStartError: MediaReason | null = null;
  let retryStartAt = 0;
  let disposed = false;

  const evictOldest = <K, V>(m: Map<K, V>) => {
    if (m.size <= ART_CACHE_MAX) return;
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  };

  const stop = (reason: string) => {
    const hadProc = proc !== null;
    if (proc) { try { proc.kill(); } catch { /* 已退出 */ } }
    proc = null;
    buffer = '';
    decoder = new StringDecoder('utf8');
    frame = null;
    artBySession.clear();
    lastChangedAt.clear();
    sessionSig.clear();
    lastStartError = null;
    retryStartAt = 0;
    if (idleTimer !== null) { clearIntervalImpl(idleTimer); idleTimer = null; }
    if (hadProc) log(`media watcher stopped (${reason})`);
  };

  const onLine = (line: string) => {
    const next = parseWatcherLine(line);
    if (!next) { badLines += 1; return; }
    const at = now();
    for (const s of next.sessions) {
      const sig = sessionSignature(s);
      if (sessionSig.get(s.appId) !== sig) {
        sessionSig.set(s.appId, sig);
        lastChangedAt.set(s.appId, at);
      }
      if (s.art) {
        rev += 1;
        const key = sessionKeyOf(s);
        artBySession.delete(key); // 重新插入以维持淘汰顺序（最近收到 art 的会话在后）
        artBySession.set(key, { bytes: s.art.bytes.slice(0, MAX_ART_BYTES), contentType: s.art.contentType, rev });
        evictOldest(artBySession);
      }
    }
    frame = next;
    lastStartError = null;
  };

  const onStartError = (p: MediaWatcherProcess) => {
    if (proc !== p) return;
    proc = null;
    buffer = '';
    decoder = new StringDecoder('utf8');
    const at = now();
    recentStartFailures = [...recentStartFailures.filter((t) => at - t < FAILURE_WINDOW_MS), at];
    lastStartError = 'no-powershell';
    retryStartAt = at + START_RETRY_MS;
    if (recentStartFailures.length >= 3) {
      degradedUntil = at + DEGRADE_MS;
      log('media watcher degraded (start failures)');
    }
    log('media watcher start failed (no-powershell)');
  };

  const start = (): MediaReason | null => {
    if (proc) return null;
    const at = now();
    recentStartFailures = recentStartFailures.filter((t) => at - t < FAILURE_WINDOW_MS);
    if (degradedUntil > at) return 'watcher-failed';
    let p: MediaWatcherProcess;
    try {
      p = spawnWatcher('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WATCH_SCRIPT]);
    } catch {
      return 'no-powershell';
    }
    const stdout = p.stdout;
    if (!stdout) {
      try { p.kill(); } catch { /* 已退出 */ }
      return 'no-powershell';
    }
    starts += 1;
    proc = p;
    stdout.on('data', (chunk: Buffer) => {
      if (proc !== p) return; // stop/dispose 后已缓冲的行不得回填
      buffer += decoder.write(chunk);
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
      if (buffer.length > 1024 * 1024) { buffer = ''; decoder = new StringDecoder('utf8'); }
    });
    p.on('error', () => { onStartError(p); });
    p.on('exit', () => {
      if (proc !== p) return;
      proc = null;
      buffer = ''; // 半行不污染重启后的首行
      decoder = new StringDecoder('utf8');
      recentStartFailures = [...recentStartFailures, now()];
      if (recentStartFailures.length >= 3) {
        degradedUntil = now() + DEGRADE_MS;
        log('media watcher degraded (restart rate)');
      }
      if (!disposed && now() - lastRequestAt < idleMs) restarts += 1;
      log('media watcher exited');
    });
    if (idleTimer === null) {
      const timer = setIntervalImpl(() => {
        if (proc && now() - lastRequestAt > idleMs) stop('idle');
      }, idleCheckMs);
      idleTimer = timer;
      const maybe = timer as { unref?: () => void } | null;
      if (maybe && typeof maybe.unref === 'function') maybe.unref();
    }
    log('media watcher started');
    return null;
  };

  return {
    request({ pageTitle, enabled }) {
      const at = now();
      if (disposed) return emptyMediaSnapshot('disabled', at);
      lastRequestAt = at;
      if (!enabled) {
        stop('disabled');
        return emptyMediaSnapshot('disabled', at);
      }
      if (platform !== 'win32') return emptyMediaSnapshot('unsupported-platform', at);
      // 无帧且刚 spawn 失败：退避窗口内直接返回，窗口外仍允许重试。
      if (!proc && !frame && lastStartError === 'no-powershell' && at < retryStartAt) {
        return emptyMediaSnapshot(degradedUntil > at ? 'watcher-failed' : 'no-powershell', at);
      }
      const failure = start();
      if (failure) return emptyMediaSnapshot(failure, at);
      if (!frame) return emptyMediaSnapshot('no-session', at);
      const { session, reason } = selectSession(frame, { ownAppId, pageTitle, lastChangedAt });
      if (!session) return emptyMediaSnapshot(reason, frame.at);
      const art = artBySession.get(sessionKeyOf(session));
      return {
        available: true,
        reason: 'ok',
        appId: session.appId,
        title: session.title,
        artist: session.artist,
        album: session.album,
        contentType: session.contentType,
        playback: playbackOfStatus(session.status),
        hasThumbnail: art !== undefined,
        thumbnailRev: art?.rev ?? 0,
        positionMs: session.positionMs,
        durationMs: session.durationMs,
        at: frame.at,
      };
    },
    thumbnail(r) {
      for (const entry of artBySession.values()) {
        if (entry.rev === r) return { bytes: entry.bytes, contentType: entry.contentType };
      }
      return null;
    },
    dispose() {
      disposed = true;
      stop('dispose');
    },
    stats() {
      return { starts, badLines, restarts, degraded: degradedUntil > now() };
    },
  };
}
