// host 媒体会话：Windows SMTC（GlobalSystemMediaTransportControlsSessionManager）。
// 进程常驻、懒启动、空闲退出；title/artist 仅内存，不落盘不写日志。
import { spawn } from 'node:child_process';
import { emptyMediaSnapshot } from '../shared/media.js';
export function playbackOfStatus(status) {
    if (status === 'Playing')
        return 'playing';
    if (status === 'Paused')
        return 'paused';
    return 'stopped';
}
// 会话签名（不含 position/art 字节）：用于 lastChangedAt 与封面重取判定。
function sessionSignature(s) {
    return [s.appId, s.title, s.artist, s.album, s.contentType, s.status].join('\u0001');
}
export function parseWatcherLine(line) {
    let raw;
    try {
        raw = JSON.parse(String(line).trim());
    }
    catch {
        return null;
    }
    const o = raw;
    if (!o || o.v !== 1 || typeof o.at !== 'number' || !Array.isArray(o.sessions))
        return null;
    const sessions = [];
    for (const item of o.sessions) {
        if (!item || typeof item !== 'object')
            continue;
        const r = item;
        const appId = typeof r.appId === 'string' ? r.appId : '';
        const title = typeof r.title === 'string' ? r.title : '';
        if (!appId && !title)
            continue;
        let art = null;
        if (typeof r.artB64 === 'string' && r.artB64) {
            try {
                const bytes = Buffer.from(r.artB64, 'base64');
                if (bytes.length > 0 && bytes.length <= 512 * 1024) {
                    art = { bytes, contentType: typeof r.artType === 'string' && r.artType ? r.artType : 'image/png' };
                }
            }
            catch {
                art = null;
            }
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
// 选择规则（spec §4.3）：剔除自身/页面标题/空标题 → playing > paused → artist 非空 → lastChangedAt 最新。
export function selectSession(frame, opts) {
    const candidates = frame.sessions.filter((s) => {
        if (!s.title)
            return false;
        if (opts.ownAppId && s.appId === opts.ownAppId)
            return false;
        if (opts.pageTitle && s.title === opts.pageTitle)
            return false;
        return playbackOfStatus(s.status) !== 'stopped';
    });
    if (candidates.length === 0)
        return { session: null, reason: 'no-session' };
    const rank = (s) => [
        playbackOfStatus(s.status) === 'playing' ? 1 : 0,
        s.artist ? 1 : 0,
        opts.lastChangedAt.get(s.appId) ?? 0,
    ];
    candidates.sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        for (let i = 0; i < 3; i++)
            if (ra[i] !== rb[i])
                return rb[i] - ra[i];
        return 0;
    });
    return { session: candidates[0], reason: 'ok' };
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
    '$initialized = $false',
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
    '    $album = [string]$p.AlbumTitle',
    '    $contentType = [string]$p.ContentType',
    '    $status = [string]$pi.PlaybackStatus',
    '    $sig = "$appId|$title|$artist|$album|$contentType|$status"',
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
    '            $lastArt[$appId] = $sig',
    '          }',
    '        }',
    '      } catch { $artB64 = "" }',
    '    }',
    '    $list += [ordered]@{ appId = $appId; status = $status; title = $title; artist = $artist; album = $album; contentType = $contentType; positionMs = [double]$tl.Position.TotalMilliseconds; durationMs = [double]$tl.EndTime.TotalMilliseconds; artB64 = $artB64; artType = $artType }',
    '  }',
    '  $signature = $sigParts -join "||"',
    '  if (-not $initialized -or $signature -ne $last) {',
    '    $last = $signature',
    '    $initialized = $true',
    '    [Console]::Out.WriteLine((ConvertTo-Json -Compress -InputObject ([ordered]@{ v = 1; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sessions = $list })))',
    '    [Console]::Out.Flush()',
    '  }',
    '  Start-Sleep -Milliseconds 700',
    '}',
].join('\n');
const DEFAULT_IDLE_MS = 20_000;
const DEFAULT_IDLE_CHECK_MS = 5_000;
const MAX_ART_BYTES = 512 * 1024;
const ART_CACHE_MAX = 8;
// 封面按会话存：同一会话后续状态变化行不再带 art，不能只记全局「最近一份」。
const sessionKeyOf = (s) => [s.appId, s.title, s.artist].join('\u0001');
export function createMediaSessionService(opts = {}) {
    const platform = opts.platform ?? process.platform;
    const now = opts.now ?? (() => Date.now());
    const log = opts.log ?? (() => { });
    const ownAppId = opts.ownAppId ?? '';
    const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    const idleCheckMs = opts.idleCheckMs ?? DEFAULT_IDLE_CHECK_MS;
    const setIntervalImpl = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
    const clearIntervalImpl = opts.clearIntervalImpl ?? ((h) => { clearInterval(h); });
    const spawnWatcher = opts.spawnImpl ?? ((cmd, args) => spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }));
    let proc = null;
    let buffer = '';
    let frame = null;
    let lastRequestAt = 0;
    let rev = 0;
    const arts = new Map();
    const artBySession = new Map();
    const lastChangedAt = new Map();
    const sessionSig = new Map();
    let idleTimer = null;
    let starts = 0;
    let restarts = 0;
    let badLines = 0;
    let degradedUntil = 0;
    let recentStartFailures = [];
    let disposed = false;
    const evictOldest = (m) => {
        if (m.size <= ART_CACHE_MAX)
            return;
        const oldest = m.keys().next().value;
        if (oldest !== undefined)
            m.delete(oldest);
    };
    const stop = (reason) => {
        const hadProc = proc !== null;
        if (proc) {
            try {
                proc.kill();
            }
            catch { /* 已退出 */ }
        }
        proc = null;
        buffer = '';
        frame = null;
        arts.clear();
        artBySession.clear();
        rev = 0;
        lastChangedAt.clear();
        sessionSig.clear();
        if (idleTimer !== null) {
            clearIntervalImpl(idleTimer);
            idleTimer = null;
        }
        if (hadProc)
            log(`media watcher stopped (${reason})`);
    };
    const onLine = (line) => {
        const next = parseWatcherLine(line);
        if (!next) {
            badLines += 1;
            return;
        }
        const at = now();
        for (const s of next.sessions) {
            const sig = sessionSignature(s);
            if (sessionSig.get(s.appId) !== sig) {
                sessionSig.set(s.appId, sig);
                lastChangedAt.set(s.appId, at);
            }
            if (s.art) {
                rev += 1;
                const entry = { bytes: s.art.bytes.slice(0, MAX_ART_BYTES), contentType: s.art.contentType, rev };
                arts.set(rev, entry);
                evictOldest(arts);
                const key = sessionKeyOf(s);
                artBySession.delete(key); // 重新插入以维持淘汰顺序（最近收到 art 的会话在后）
                artBySession.set(key, entry);
                evictOldest(artBySession);
            }
        }
        frame = next;
    };
    const start = () => {
        if (proc)
            return null;
        const at = now();
        recentStartFailures = recentStartFailures.filter((t) => at - t < 60_000);
        if (degradedUntil > at)
            return 'watcher-failed';
        let p;
        try {
            p = spawnWatcher('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WATCH_SCRIPT]);
        }
        catch {
            return 'no-powershell';
        }
        const stdout = p.stdout;
        if (!stdout) {
            try {
                p.kill();
            }
            catch { /* 已退出 */ }
            return 'no-powershell';
        }
        starts += 1;
        proc = p;
        stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            for (;;) {
                const idx = buffer.indexOf('\n');
                if (idx < 0)
                    break;
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (line.trim())
                    onLine(line);
            }
            if (buffer.length > 1024 * 1024)
                buffer = '';
        });
        p.on('exit', () => {
            if (proc !== p)
                return;
            proc = null;
            recentStartFailures = [...recentStartFailures, now()];
            if (recentStartFailures.length >= 3) {
                degradedUntil = now() + 60_000;
                log('media watcher degraded (restart rate)');
            }
            if (!disposed && now() - lastRequestAt < idleMs)
                restarts += 1;
            log('media watcher exited');
        });
        idleTimer ??= setIntervalImpl(() => {
            if (proc && now() - lastRequestAt > idleMs)
                stop('idle');
        }, idleCheckMs);
        log('media watcher started');
        return null;
    };
    return {
        request({ pageTitle, enabled }) {
            lastRequestAt = now();
            if (!enabled) {
                stop('disabled');
                return emptyMediaSnapshot('disabled', lastRequestAt);
            }
            if (platform !== 'win32')
                return emptyMediaSnapshot('unsupported-platform', lastRequestAt);
            const failure = start();
            if (failure)
                return emptyMediaSnapshot(failure, lastRequestAt);
            if (!frame)
                return emptyMediaSnapshot('no-session', lastRequestAt);
            const { session, reason } = selectSession(frame, { ownAppId, pageTitle, lastChangedAt });
            if (!session)
                return emptyMediaSnapshot(reason, frame.at);
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
            const hit = arts.get(r);
            return hit ? { bytes: hit.bytes, contentType: hit.contentType } : null;
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
