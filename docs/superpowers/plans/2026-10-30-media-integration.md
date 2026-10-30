# 媒体集成（Windows SMTC + media 事件 + 时间线动画）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `3797976859 小作 2(有声)` 在 DSH 里不再常驻白框，并在本机播放媒体时显示封面/歌名/歌手/主色边框/淡入滑入动画（Windows SMTC 媒体集成 + SceneScript media 事件 + 时间线属性动画）。

**Architecture:** host 侧常驻一个 PowerShell watcher（WinRT SMTC，懒启动、空闲退出）→ 两条只读路由；client 侧 1s 轮询成快照，diff 后把 `mediaPlaybackChanged / mediaStatusChanged / mediaPropertiesChanged / mediaThumbnailChanged` 派发进既有 SceneScript VM 与 text 脚本运行时；另一条独立支线实现 scene.json 属性时间线动画（贝塞尔/播放模式/父子联动）与 `$mediaThumbnail` 实例纹理绑定。

**Tech Stack:** TypeScript（`tsc` 构建 `lib/`、esbuild 构建 `dist/client.js`）、Cordis 插件、three.js r170、QuickJS（quickjs-emscripten）、vitest、PowerShell 5.1 + WinRT（`Windows.Media.Control`）。**不引入新依赖。**

**Spec:** `docs/superpowers/specs/2026-10-30-media-integration-design.md`

## Global Constraints

- 所有代码遵守仓库 `AGENT.md` 约定；注释/提交信息中文从简（提交标题一行 + 正文 ≤3 行）。
- 架构边界守卫零容忍：`src/host/**` 不得 import `src/client/**` / `three|react`；`src/client/**` 不得 import `src/host/**`；`src/shared/**` 纯类型/纯函数。运行 `npm run verify:arch` 必须绿。
- 每个 Task 走 TDD：先写失败测试 → 运行确认失败 → 最小实现 → 运行通过 → 提交。**一个 Task 一个 commit**（提交标题见各 Task 末尾）。
- 命令约定：单测 `npx vitest run tests/<file>.test.ts`；全量 `npm test`；构建 renderer 产物 `npm run build`（tsc → `lib/`，e2e/脚本用）；客户端产物 `npm run build:client`（→ `dist/client.js`）；类型检查测试 `npm run typecheck:tests`；架构守卫 `npm run verify:arch`。
- **隐私硬约束**：媒体 title/artist/album 只能存在于内存与事件 payload；host 日志只允许状态/原因/计数，**禁止**打印或落盘歌名/歌手/封面字节。
- **仅 Windows 宿主**：`process.platform !== 'win32'` 时媒体服务返回 `unsupported-platform`（不 spawn）。macOS/Linux 行为 = 媒体层隐藏（白框消失），不得抛错。
- 除 spec 的 errata 外不改既有对外行为：无 media 脚本 / 无 `$mediaThumbnail` 的壁纸不得创建轮询、不得派发媒体事件、不得新增每帧开销。
- spec errata（本计划执行口径）：① 媒体路由改用 `/wallpapers/now-playing` 与 `/wallpapers/now-playing/thumbnail`（既有 `/wallpapers/media` 是 prefix 路由，避免前缀歧义）；② `scene.json` 多脚本从 `objectScripts: Array<{property, script, scriptProperties?}>` 表达（替换原 `objectScript/objectScriptProperty/objectScriptProperties` 三字段）；③ visible 脚本统一从 `obj.visible.script` 取（修掉 text 对象 text.script 覆盖 visible.script 的既有缺陷）；④ 时间线动画不更新 isolated 对象的合成 quad（本机样本无此形态，记入已知边界）。
- 执行环境需本机壁纸库（`D:/Steam/steamapps/workshop/content/431960`）与 WE 安装目录（`D:/Steam/steamapps/common/wallpaper_engine`）；e2e 只在本机跑（沿用现有 e2e 不入 CI 的口径）。

---

## Task 1: 共享媒体类型 + SMTC watcher 行协议/会话选择（纯函数）

**Files:**
- Create: `src/shared/media.ts`
- Create: `src/host/media-session.ts`（本 Task 只放纯函数与 `WATCH_SCRIPT` 常量；Service 在 Task 2）
- Test: `tests/media-session.test.ts`

**Interfaces:**
- Produces（后续 Task 依赖的精确签名）：
```ts
// src/shared/media.ts
export type MediaPlaybackState = 'stopped' | 'playing' | 'paused';
export type MediaReason = 'ok' | 'no-session' | 'disabled' | 'unsupported-platform' | 'no-powershell' | 'watcher-failed';
export type MediaRgb = [number, number, number];
export interface MediaSessionSnapshot {
  available: boolean; reason: MediaReason;
  appId: string; title: string; artist: string; album: string; contentType: string;
  playback: MediaPlaybackState; hasThumbnail: boolean; thumbnailRev: number;
  positionMs: number | null; durationMs: number | null; at: number;
}
export interface MediaPalette { primary: MediaRgb; secondary: MediaRgb; tertiary: MediaRgb; text: MediaRgb; highContrast: MediaRgb; }
export function emptyMediaSnapshot(reason: MediaReason, at?: number): MediaSessionSnapshot;

// src/host/media-session.ts
export interface RawMediaSession {
  appId: string; status: string; title: string; artist: string; album: string; contentType: string;
  positionMs: number; durationMs: number;
  art: { bytes: Buffer; contentType: string } | null;
}
export interface WatcherFrame { at: number; sessions: RawMediaSession[] }
export function playbackOfStatus(status: string): MediaPlaybackState;
export function parseWatcherLine(line: string): WatcherFrame | null;
export interface SessionSelectionOptions { ownAppId: string; pageTitle: string; lastChangedAt: ReadonlyMap<string, number> }
export function selectSession(frame: WatcherFrame, opts: SessionSelectionOptions): { session: RawMediaSession | null; reason: MediaReason };
export const WATCH_SCRIPT: string;
```

- [ ] **Step 1: 写失败测试**

`tests/media-session.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { parseWatcherLine, selectSession, playbackOfStatus, WATCH_SCRIPT } from '../src/host/media-session.js';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const rawLine = (sessions: unknown[], at = 1000) => JSON.stringify({ v: 1, at, sessions });

describe('playbackOfStatus', () => {
  it('Playing/Paused → playing/paused；其余（Closed/Opened/Changing/Stopped/未知）→ stopped', () => {
    expect(playbackOfStatus('Playing')).toBe('playing');
    expect(playbackOfStatus('Paused')).toBe('paused');
    for (const s of ['Closed', 'Opened', 'Changing', 'Stopped', '']) expect(playbackOfStatus(s)).toBe('stopped');
  });
});

describe('parseWatcherLine', () => {
  it('解析合法行（含封面字节与 content type）', () => {
    const r = parseWatcherLine(rawLine([{
      appId: 'Spotify.exe', status: 'Playing', title: '歌名', artist: '歌手', album: '专辑',
      contentType: 'music', positionMs: 12, durationMs: 300, artB64: b64('png'), artType: 'image/png',
    }]));
    expect(r?.at).toBe(1000);
    expect(r?.sessions).toHaveLength(1);
    expect(r?.sessions[0]).toMatchObject({ appId: 'Spotify.exe', title: '歌名', artist: '歌手', album: '专辑', contentType: 'music' });
    expect(r?.sessions[0]?.art?.bytes.equals(Buffer.from('png'))).toBe(true);
    expect(r?.sessions[0]?.art?.contentType).toBe('image/png');
  });
  it('无封面 ⇒ art=null；坏 artB64 ⇒ art=null（不丢整行）', () => {
    expect(parseWatcherLine(rawLine([{ appId: 'a', status: 'Playing', title: 't' }]))?.sessions[0]?.art).toBeNull();
    expect(parseWatcherLine(rawLine([{ appId: 'a', status: 'Playing', title: 't', artB64: '!!!' }]))?.sessions[0]?.art).toBeNull();
  });
  it('非 JSON / 版本不符 / sessions 非数组 / 缺 at ⇒ null', () => {
    expect(parseWatcherLine('not json')).toBeNull();
    expect(parseWatcherLine(JSON.stringify({ v: 2, at: 1, sessions: [] }))).toBeNull();
    expect(parseWatcherLine(JSON.stringify({ v: 1, at: 1, sessions: {} }))).toBeNull();
    expect(parseWatcherLine(JSON.stringify({ v: 1, sessions: [] }))).toBeNull();
  });
  it('坏会话条目被跳过，合法条目保留', () => {
    const r = parseWatcherLine(rawLine([{ appId: 1 }, { appId: 'b', status: 'Paused', title: 'B' }]));
    expect(r?.sessions.map((s) => s.appId)).toEqual(['b']);
  });
});

const frame = (sessions: Array<Partial<RawSessionLike>>) => ({
  at: 1,
  sessions: sessions.map((s) => ({
    appId: '', status: 'Playing', title: '', artist: '', album: '', contentType: '', positionMs: 0, durationMs: 0, art: null, ...s,
  })),
});
type RawSessionLike = Awaited<ReturnType<typeof parseWatcherLine>> extends null ? never : NonNullable<ReturnType<typeof parseWatcherLine>>['sessions'][number];

describe('selectSession', () => {
  const base = { ownAppId: 'DeepSeek Harness.exe', pageTitle: 'D对话 — DeepSeek Harness', lastChangedAt: new Map<string, number>() };
  it('剔除自身 app 与页面标题会话，空标题剔除', () => {
    const r = selectSession(frame([
      { appId: 'DeepSeek Harness.exe', title: 'D对话 — DeepSeek Harness', artist: 'X' },
      { appId: 'msedge.exe', title: 'D对话 — DeepSeek Harness' },
      { appId: 'spotify.exe', title: '' },
    ]), base);
    expect(r).toEqual({ session: null, reason: 'no-session' });
  });
  it('playing 优先于 paused；再按 artist 非空；再按 lastChangedAt 最新', () => {
    const r = selectSession(frame([
      { appId: 'a', title: 'A', status: 'Paused', artist: 'x' },
      { appId: 'b', title: 'B', status: 'Playing' },
    ]), base);
    expect(r.session?.appId).toBe('b');
    const r2 = selectSession(frame([
      { appId: 'a', title: 'A', status: 'Playing' },
      { appId: 'b', title: 'B', status: 'Playing', artist: 'y' },
    ]), base);
    expect(r2.session?.appId).toBe('b');
    const lastChangedAt = new Map([['a', 100], ['b', 50]]);
    const r3 = selectSession(frame([
      { appId: 'a', title: 'A', status: 'Playing', artist: 'x' },
      { appId: 'b', title: 'B', status: 'Playing', artist: 'y' },
    ]), { ...base, lastChangedAt });
    expect(r3.session?.appId).toBe('a');
  });
  it('命中 ⇒ reason ok', () => {
    expect(selectSession(frame([{ appId: 'a', title: 'A' }]), base)).toEqual({
      session: expect.objectContaining({ appId: 'a' }), reason: 'ok',
    });
  });
});

it('WATCH_SCRIPT 是常量 PowerShell：输出 UTF8 JSON 行、枚举 SMTC 会话', () => {
  expect(WATCH_SCRIPT).toContain('GlobalSystemMediaTransportControlsSessionManager');
  expect(WATCH_SCRIPT).toContain('GetSessions');
  expect(WATCH_SCRIPT).toContain('OutputEncoding');
  expect(WATCH_SCRIPT).toContain('WriteLine');
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/media-session.test.ts`
Expected: FAIL（`Cannot find module '../src/host/media-session.js'`）

- [ ] **Step 3: 写最小实现**

`src/shared/media.ts`：
```ts
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

export interface MediaPalette {
  primary: MediaRgb; secondary: MediaRgb; tertiary: MediaRgb; text: MediaRgb; highContrast: MediaRgb;
}

/** 中性快照：所有失败/无会话路径共用（available=false ⇒ 客户端派发 stopped）。 */
export function emptyMediaSnapshot(reason: MediaReason, at = 0): MediaSessionSnapshot {
  return {
    available: false, reason, appId: '', title: '', artist: '', album: '', contentType: '',
    playback: 'stopped', hasThumbnail: false, thumbnailRev: 0, positionMs: null, durationMs: null, at,
  };
}
```

`src/host/media-session.ts`（本 Task 部分）：
```ts
// host 媒体会话：Windows SMTC（GlobalSystemMediaTransportControlsSessionManager）。
// 进程常驻、懒启动、空闲退出；title/artist 仅内存，不落盘不写日志。
import type { MediaPlaybackState, MediaReason } from '../shared/media.js';

export interface RawMediaSession { /* 见上 */ }
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
  '$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq "IAsyncOperation`1" })[0]',
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
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/media-session.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: 提交**

```bash
git add src/shared/media.ts src/host/media-session.ts tests/media-session.test.ts
git commit -m "feat(media): SMTC watcher 行协议与会话选择" -m "- 纯函数可单测：状态映射、行解析、自会话/页面标题过滤、优先级排序" -m "- WATCH_SCRIPT 为常量 PowerShell，UTF8 JSON 行输出"
```

---

## Task 2: MediaSessionService（进程生命周期 + 封面缓存 + 快照）

**Files:**
- Modify: `src/host/media-session.ts`（追加 Service，不删 Task 1 内容）
- Test: `tests/media-session.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 的 `WatcherFrame/parseWatcherLine/selectSession/playbackOfStatus`。
- Produces：
```ts
export interface MediaWatcherProcess {
  stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer) => void): void } | null;
  kill(): void;
  on(event: 'exit', cb: (code?: number | null) => void): void;
}
export interface MediaSessionServiceOptions {
  platform?: NodeJS.Platform;
  spawnImpl?: (cmd: string, args: string[]) => MediaWatcherProcess;
  now?: () => number;
  ownAppId?: string;
  log?: (msg: string) => void;
  idleMs?: number;       // 20000
  idleCheckMs?: number;  // 5000
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (h: unknown) => void;
}
export interface MediaSessionService {
  request(opts: { pageTitle: string; enabled: boolean }): MediaSessionSnapshot;
  thumbnail(rev: number): { bytes: Buffer; contentType: string } | null;
  dispose(): void;
  stats(): { starts: number; badLines: number; restarts: number; degraded: boolean };
}
export function createMediaSessionService(opts?: MediaSessionServiceOptions): MediaSessionService;
```

- [ ] **Step 1: 写失败测试（追加到 `tests/media-session.test.ts`）**

```ts
import { createMediaSessionService } from '../src/host/media-session.js';
import { PassThrough } from 'node:stream';

/** 假 PowerShell 进程：stdout 是 PassThrough，kill 记录调用，exit 用回调手动触发。 */
function fakeProc() {
  const stdout = new PassThrough();
  const exitCbs: Array<() => void> = [];
  return {
    stdout,
    killed: 0,
    exitCbs,
    kill() { this.killed += 1; },
    on(_e: 'exit', cb: () => void) { exitCbs.push(cb); },
  };
}
function setupService() {
  const procs: ReturnType<typeof fakeProc>[] = [];
  const timers: Array<() => void> = [];
  let now = 0;
  const svc = createMediaSessionService({
    platform: 'win32',
    ownAppId: 'DeepSeek Harness.exe',
    spawnImpl: () => { const p = fakeProc(); procs.push(p); return p as any; },
    now: () => now,
    idleMs: 20_000,
    idleCheckMs: 5_000,
    setIntervalImpl: (fn: () => void) => { timers.push(fn); return timers.length - 1; },
    clearIntervalImpl: () => { /* noop：测试直接调 check */ },
    log: () => {},
  });
  return { svc, procs, timers, tick: (ms: number) => { now += ms; timers.forEach((f) => f()); }, feed: (line: object) => procs[0]!.stdout.write(JSON.stringify(line) + '\n') };
}

it('request：懒启动单实例；无数据 ⇒ no-session；喂行后返回选中会话快照', () => {
  const { svc, procs, feed } = setupService();
  expect(procs).toHaveLength(0);
  const first = svc.request({ pageTitle: 'D — DeepSeek Harness', enabled: true });
  expect(first).toMatchObject({ available: false, reason: 'no-session', playback: 'stopped' });
  expect(procs).toHaveLength(1);
  svc.request({ pageTitle: 'D — DeepSeek Harness', enabled: true });
  expect(procs).toHaveLength(1);
  feed({ v: 1, at: 1, sessions: [{ appId: 'Spotify.exe', status: 'Playing', title: 'T', artist: 'A', album: 'Al', contentType: 'music', positionMs: 3, durationMs: 9 }] });
  const snap = svc.request({ pageTitle: 'D — DeepSeek Harness', enabled: true });
  expect(snap).toMatchObject({ available: true, reason: 'ok', playback: 'playing', title: 'T', artist: 'A', album: 'Al' });
});

it('封面字节缓存：rev 递增且可读；坏行计 badLines；进程退出后下一请求重启', () => {
  const { svc, procs, feed } = setupService();
  svc.request({ pageTitle: 'x', enabled: true });
  feed({ v: 1, at: 1, sessions: [{ appId: 'a', status: 'Playing', title: 'T', artist: 'A', artB64: Buffer.from('ABC').toString('base64'), artType: 'image/jpeg' }] });
  const snap = svc.request({ pageTitle: 'x', enabled: true });
  expect(snap.hasThumbnail).toBe(true);
  expect(svc.thumbnail(snap.thumbnailRev)?.bytes.toString('utf8')).toBe('ABC');
  expect(svc.thumbnail(999)).toBeNull();
  procs[0]!.stdout.write('garbage\n');
  expect(svc.stats().badLines).toBe(1);
  procs[0]!.exitCbs.forEach((cb) => cb());
  svc.request({ pageTitle: 'x', enabled: true });
  expect(procs).toHaveLength(2);
});

it('空闲 20s 无请求 ⇒ kill；disabled / 非 win32 / 无 PowerShell ⇒ 不启动并返回对应 reason', () => {
  const { svc, procs, tick, feed } = setupService();
  svc.request({ pageTitle: 'x', enabled: true });
  feed({ v: 1, at: 1, sessions: [{ appId: 'a', status: 'Playing', title: 'T' }] });
  svc.request({ pageTitle: 'x', enabled: true });
  tick(20_001);
  expect(procs[0]!.killed).toBe(1);
  expect(svc.thumbnail(1)).toBeNull();
  const disabled = setupService();
  expect(disabled.svc.request({ pageTitle: 'x', enabled: false })).toMatchObject({ available: false, reason: 'disabled' });
  expect(disabled.procs).toHaveLength(0);
  const mac = createMediaSessionService({ platform: 'darwin' });
  expect(mac.request({ pageTitle: 'x', enabled: true })).toMatchObject({ available: false, reason: 'unsupported-platform' });
  const noPs = createMediaSessionService({ platform: 'win32', spawnImpl: () => { throw new Error('ENOENT'); } as any, log: () => {} });
  expect(noPs.request({ pageTitle: 'x', enabled: true })).toMatchObject({ available: false, reason: 'no-powershell' });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/media-session.test.ts`
Expected: FAIL（`createMediaSessionService is not a function`）

- [ ] **Step 3: 写最小实现（追加 Service 部分）**

```ts
import { spawn } from 'node:child_process';
import { emptyMediaSnapshot, type MediaSessionSnapshot } from '../shared/media.js';

const DEFAULT_IDLE_MS = 20_000;
const DEFAULT_IDLE_CHECK_MS = 5_000;
const MAX_ART_BYTES = 512 * 1024;
const ART_CACHE_MAX = 8;

// …（Task 1 的纯函数）…

interface ArtEntry { bytes: Buffer; contentType: string; rev: number }

export function createMediaSessionService(opts: MediaSessionServiceOptions = {}) {
  const platform = opts.platform ?? process.platform;
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? (() => {});
  const ownAppId = opts.ownAppId ?? '';
  const idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
  const idleCheckMs = opts.idleCheckMs ?? DEFAULT_IDLE_CHECK_MS;
  const setIntervalImpl = opts.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval;

  let proc: MediaWatcherProcess | null = null;
  let buffer = '';
  let frame: WatcherFrame | null = null;
  let lastRequestAt = 0;
  let rev = 0;
  const arts = new Map<number, ArtEntry>();
  const lastChangedAt = new Map<string, number>();
  const sessionSig = new Map<string, string>();
  let idleTimer: unknown = null;
  let starts = 0;
  let restarts = 0;
  let badLines = 0;
  let degradedUntil = 0;
  let recentStartFailures: number[] = [];
  let disposed = false;

  const stop = (reason: string) => {
    if (!proc) return;
    try { proc.kill(); } catch { /* 已退出 */ }
    proc = null;
    buffer = '';
    frame = null;
    arts.clear();
    rev = 0;
    lastChangedAt.clear();
    sessionSig.clear();
    if (idleTimer !== null) { clearIntervalImpl(idleTimer); idleTimer = null; }
    log(`media watcher stopped (${reason})`);
  };

  const onLine = (line: string) => {
    const next = parseWatcherLine(line);
    if (!next) { badLines += 1; return; }
    const at = now();
    for (const s of next.sessions) {
      const sig = [s.appId, s.title, s.artist, s.album, s.contentType, s.status].join('\u0001');
      if (sessionSig.get(s.appId) !== sig) {
        sessionSig.set(s.appId, sig);
        lastChangedAt.set(s.appId, at);
      }
      if (s.art) {
        rev += 1;
        arts.set(rev, { bytes: s.art.bytes.slice(0, MAX_ART_BYTES), contentType: s.art.contentType, rev });
        if (arts.size > ART_CACHE_MAX) { const first = arts.keys().next().value; if (first !== undefined) arts.delete(first); }
      }
    }
    frame = next;
  };

  const start = (): MediaReason | null => {
    if (proc) return null;
    const at = now();
    recentStartFailures = recentStartFailures.filter((t) => at - t < 60_000);
    if (degradedUntil > at) return 'watcher-failed';
    const spawnImpl = opts.spawnImpl ?? ((cmd: string, args: string[]) => spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) as unknown as MediaWatcherProcess);
    let p: MediaWatcherProcess;
    try {
      p = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WATCH_SCRIPT]);
    } catch {
      return 'no-powershell';
    }
    if (!p || !p.stdout) { try { p?.kill(); } catch { /* noop */ } return 'no-powershell'; }
    starts += 1;
    proc = p;
    p.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.trim()) onLine(line);
      }
      if (buffer.length > 1024 * 1024) buffer = '';
    });
    p.on('exit', () => {
      if (proc !== p) return;
      proc = null;
      recentStartFailures = [...recentStartFailures, now()];
      if (recentStartFailures.length >= 3) { degradedUntil = now() + 60_000; log('media watcher degraded (restart rate)'); }
      if (!disposed && now() - lastRequestAt < idleMs) restarts += 1;
      log('media watcher exited');
    });
    idleTimer ??= setIntervalImpl(() => {
      if (proc && now() - lastRequestAt > idleMs) stop('idle');
    }, idleCheckMs);
    log('media watcher started');
    return null;
  };

  return {
    request({ pageTitle, enabled }: { pageTitle: string; enabled: boolean }): MediaSessionSnapshot {
      lastRequestAt = now();
      if (!enabled) { stop('disabled'); return emptyMediaSnapshot('disabled', lastRequestAt); }
      if (platform !== 'win32') return emptyMediaSnapshot('unsupported-platform', lastRequestAt);
      const failure = start();
      if (failure) return emptyMediaSnapshot(failure, lastRequestAt);
      if (!frame) return emptyMediaSnapshot('no-session', lastRequestAt);
      const { session, reason } = selectSession(frame, { ownAppId, pageTitle, lastChangedAt });
      if (!session) return emptyMediaSnapshot(reason, frame.at);
      const playback = playbackOfStatus(session.status);
      let artRev = 0;
      if (session.art) {
        artRev = rev;
      }
      return {
        available: true, reason: 'ok', appId: session.appId, title: session.title, artist: session.artist,
        album: session.album, contentType: session.contentType, playback,
        hasThumbnail: artRev > 0, thumbnailRev: artRev,
        positionMs: session.positionMs, durationMs: session.durationMs, at: frame.at,
      };
    },
    thumbnail(r: number) {
      const hit = arts.get(r);
      return hit ? { bytes: hit.bytes, contentType: hit.contentType } : null;
    },
    dispose() { disposed = true; stop('dispose'); },
    stats() { return { starts, badLines, restarts, degraded: degradedUntil > now() }; },
  } satisfies MediaSessionService;
}
```

> 注：`request` 里的封面 rev 语义是「最近一次收到的封面」；同会话切歌会收到新 art ⇒ rev 变化（客户端据此重取）。若同一会话重发不带 art 的签名变化行，rev 保持不变（客户端不重取）。

- [ ] **Step 4: 运行确认通过 + 全量**

Run: `npx vitest run tests/media-session.test.ts` → PASS
Run: `npm test` → 全绿（新增测试不影响既有）

- [ ] **Step 5: 提交**

```bash
git add src/host/media-session.ts tests/media-session.test.ts
git commit -m "feat(media): 常驻 SMTC watcher 服务" -m "- 懒启动/空闲 20s 退出/退出重启/失败降级；封面字节内存缓存（不落盘）" -m "- 可注入 spawn 与定时器，测试不真起 PowerShell"
```

---

## Task 3: host 路由 + 设置字段 + host 装配

**Files:**
- Modify: `src/host/routes.ts`（Options + 两条路由 + 服务生命周期）
- Modify: `src/host/index.ts`（state 增加 `mediaIntegrationEnabled` + 传参）
- Modify: `src/host/settings.ts`（`mediaIntegrationEnabled` 字段）
- Test: `tests/routes.test.ts`（新增两条路由用例 + 更新注册清单断言）
- Test: `tests/host-apply.test.ts`（更新注册清单断言）

**Interfaces:**
- Consumes: `createMediaSessionService` / `MediaSessionService`（Task 2）。
- Produces：
```ts
// WallpaperRoutesOptions 追加：
mediaIntegrationEnabled?: () => boolean;
mediaSession?: MediaSessionService; // 测试注入；缺省 createMediaSessionService()
// WallpaperRuntimeState 追加：
mediaIntegrationEnabled: boolean;
```

- [ ] **Step 1: 写失败测试（`tests/routes.test.ts` 追加）**

```ts
it('now-playing：disabled ⇒ disabled 且不 spawn；注入 session 时透传快照与封面', async () => {
  const calls: Array<{ pageTitle: string; enabled: boolean }> = [];
  const fakeSession = {
    request: (o: { pageTitle: string; enabled: boolean }) => {
      calls.push(o);
      return { available: true, reason: 'ok', appId: 'spotify.exe', title: 'T', artist: 'A', album: '',
        contentType: 'music', playback: 'playing', hasThumbnail: true, thumbnailRev: 7, positionMs: 1, durationMs: 2, at: 3 };
    },
    thumbnail: (r: number) => (r === 7 ? { bytes: Buffer.from('PNG'), contentType: 'image/png' } : null),
    dispose: () => {},
    stats: () => ({ starts: 1, badLines: 0, restarts: 0, degraded: false }),
  };
  const ctx = makeCtx();
  registerWallpaperRoutes(ctx, { wallpaperDir: dir, mediaSession: fakeSession as any, mediaIntegrationEnabled: () => true });

  const snap = makeRes();
  await routes.get('exact /wallpapers/now-playing')!({ url: '/wallpapers/now-playing?title=' + encodeURIComponent('D — DeepSeek Harness') }, snap);
  expect(snap.statusCode).toBe(200);
  expect(JSON.parse(snap.body.toString())).toMatchObject({ available: true, playback: 'playing', title: 'T' });
  expect(calls[0]).toEqual({ pageTitle: 'D — DeepSeek Harness', enabled: true });

  const art = makeRes();
  await routes.get('exact /wallpapers/now-playing/thumbnail')!({ url: '/wallpapers/now-playing/thumbnail?rev=7' }, art);
  expect(art.statusCode).toBe(200);
  expect(art.headers['Content-Type']).toBe('image/png');
  const miss = makeRes();
  await routes.get('exact /wallpapers/now-playing/thumbnail')!({ url: '/wallpapers/now-playing/thumbnail?rev=8' }, miss);
  expect(miss.statusCode).toBe(404);
});
```

同时把该文件与 `tests/host-apply.test.ts` 里「固定路由清单」断言改为包含新两条：`'exact /wallpapers/now-playing'`、`'exact /wallpapers/now-playing/thumbnail'`（按现有断言形式追加，条数 9 → 11）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/routes.test.ts tests/host-apply.test.ts`
Expected: FAIL（新路由 key 不存在 / 清单条数不符）

- [ ] **Step 3: 实现**

`src/host/routes.ts`：
```ts
// import 追加
import { createMediaSessionService, type MediaSessionService } from './media-session.js';

export interface WallpaperRoutesOptions {
  // …既有字段…
  /** 媒体集成开关（设置热更新；缺省视为 true）。 */
  mediaIntegrationEnabled?: () => boolean;
  /** 测试注入；缺省在路由闭包里懒创建。 */
  mediaSession?: MediaSessionService;
}

// registerWallpaperRoutes 内、`const listCache = …` 之后：
const mediaSession = opts.mediaSession ?? createMediaSessionService({
  log: (msg) => { /* 只记状态，绝不记 title/artist */ console.warn(`[wallpaper-engine] ${msg}`); },
});
// httpCtx 销毁时释放 watcher 进程（Cordis 新旧两种清理 API 都兼容）
const disposeMedia = () => mediaSession.dispose();
if (typeof httpCtx?.effect === 'function') httpCtx.effect(() => disposeMedia, 'wallpaper-engine: media session');
else if (typeof httpCtx?.on === 'function') httpCtx.on('dispose', disposeMedia);

// 在 /wallpapers/probe 附近追加两条 exact 路由：
server.register({
  kind: 'exact', path: '/wallpapers/now-playing',
  handler: (_req: any, res: any) => {
    const { search } = parseUrl(_req);
    const enabled = opts.mediaIntegrationEnabled?.() ?? true;
    json(res, 200, mediaSession.request({ pageTitle: search.get('title') ?? '', enabled }));
  },
});
server.register({
  kind: 'exact', path: '/wallpapers/now-playing/thumbnail',
  handler: (_req: any, res: any) => {
    const { search } = parseUrl(_req);
    const rev = Number(search.get('rev') ?? '0');
    if (!Number.isSafeInteger(rev) || rev <= 0) return json(res, 400, { error: 'bad rev' });
    const art = mediaSession.thumbnail(rev);
    if (!art) return json(res, 404, { error: 'no thumbnail' });
    res.writeHead(200, { 'Content-Type': art.contentType || 'image/png', 'Content-Length': art.bytes.length, 'Cache-Control': 'no-store' });
    res.end(art.bytes);
  },
});
```

`src/host/index.ts`：
```ts
export interface WallpaperRuntimeState { wallpaperDir: string; weAssetsDir: string; mediaIntegrationEnabled: boolean }

// apply 内：
let userMediaIntegration = true;
const state: WallpaperRuntimeState = {
  get wallpaperDir() { … },
  get weAssetsDir() { … },
  get mediaIntegrationEnabled() {
    const v = userMediaIntegration ?? configValue(config).mediaIntegrationEnabled;
    return typeof v === 'boolean' ? v : true;
  },
};
const applySettings = (value: any) => {
  userWallpaperDir = value?.wallpaperDir || '';
  userWeAssetsDir = value?.weAssetsDir || '';
  if (typeof value?.mediaIntegrationEnabled === 'boolean') userMediaIntegration = value.mediaIntegrationEnabled;
};
// registerWallpaperRoutes 调用追加：
mediaIntegrationEnabled: () => state.mediaIntegrationEnabled,
```
（注意：`let userMediaIntegration: boolean | undefined;`；旧版 `applySettings` 在 `settings.register` 分支早已存在，把上述两行并入；modern 分支 `configValue(config)` 实时读。）

`src/host/settings.ts`：在 `soundEnabled` 之后加：
```ts
  // 媒体集成（Windows SMTC 只读；数据仅内存、不落盘、不记日志）。
  mediaIntegrationEnabled: z.boolean().default(true),
```

- [ ] **Step 4: 运行确认通过 + 守卫**

Run: `npx vitest run tests/routes.test.ts tests/host-apply.test.ts tests/media-session.test.ts` → PASS
Run: `npm run verify:arch` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/host/routes.ts src/host/index.ts src/host/settings.ts tests/routes.test.ts tests/host-apply.test.ts
git commit -m "feat(media): now-playing 路由与媒体集成设置" -m "- GET /wallpapers/now-playing(+/thumbnail)，只读内存快照；watcher 随 webServer 生命周期释放" -m "- 设置新增 mediaIntegrationEnabled（默认开，关闭不拉起进程）"
```

---

## Task 4: client 媒体轮询总线（`media-input.ts`）

**Files:**
- Create: `src/client/media-input.ts`
- Test: `tests/media-input.test.ts`

**Interfaces:**
- Consumes: `MediaSessionSnapshot`（shared）。
- Produces：
```ts
export interface MediaInputOptions {
  fetchImpl?: (url: string) => Promise<{ ok: boolean; json(): Promise<MediaSessionSnapshot> }>;
  pageTitle?: () => string;
  intervalMs?: number;   // 1000
  backoffMs?: number;    // 10000（连续 3 次失败后）
  setIntervalImpl?: (fn: () => void, ms: number) => unknown;
  clearIntervalImpl?: (h: unknown) => void;
  onSnapshot: (next: MediaSessionSnapshot, prev: MediaSessionSnapshot | null) => void;
  onError?: (error: unknown) => void;
}
export interface MediaInput { start(): void; stop(): void; setPaused(paused: boolean): void; pollNow(): Promise<void>; isRunning(): boolean; dispose(): void }
export function createMediaInput(opts: MediaInputOptions): MediaInput;
export function diffSnapshot(prev: MediaSessionSnapshot | null, next: MediaSessionSnapshot): string[];
export function mediaUrl(pageTitle: string): string;
```

- [ ] **Step 1: 写失败测试**

`tests/media-input.test.ts`：
```ts
import { describe, expect, it, vi } from 'vitest';
import { createMediaInput, diffSnapshot, mediaUrl } from '../src/client/media-input.js';
import { emptyMediaSnapshot, type MediaSessionSnapshot } from '../src/shared/media.js';

const snap = (patch: Partial<MediaSessionSnapshot>): MediaSessionSnapshot => ({ ...emptyMediaSnapshot('ok', 1), ...patch });

describe('diffSnapshot', () => {
  it('首次返回所有变化键；仅 positionMs/at 变化 ⇒ 空数组', () => {
    expect(diffSnapshot(null, snap({ available: true, title: 'T' }))).toEqual(
      expect.arrayContaining(['available', 'reason', 'title', 'playback']),
    );
    expect(diffSnapshot(snap({ available: true, title: 'T' }), snap({ available: true, title: 'T', at: 9 }))).toEqual([]);
  });
  it('切歌/封面变化分别产出 title 与 thumbnailRev', () => {
    const prev = snap({ available: true, title: 'A', thumbnailRev: 2 });
    expect(diffSnapshot(prev, snap({ available: true, title: 'B', thumbnailRev: 3 }))).toEqual(['title', 'thumbnailRev']);
  });
});

describe('createMediaInput', () => {
  it('每秒轮询一次；快照变化回调；pageTitle 写入 URL', async () => {
    const timers: Array<() => void> = [];
    const urls: string[] = [];
    const got: MediaSessionSnapshot[] = [];
    let payload = snap({ available: true, title: 'A' });
    const input = createMediaInput({
      pageTitle: () => 'D — DeepSeek Harness',
      fetchImpl: async (url) => { urls.push(url); return { ok: true, json: async () => payload }; },
      setIntervalImpl: (fn) => { timers.push(fn); return timers.length - 1; },
      clearIntervalImpl: () => {},
      onSnapshot: (_n, _p) => got.push(_n),
    });
    input.start();
    await input.pollNow();
    expect(urls[0]).toBe('/wallpapers/now-playing?title=' + encodeURIComponent('D — DeepSeek Harness'));
    expect(got).toHaveLength(1);
    await input.pollNow(); // 无变化 ⇒ 不再回调
    expect(got).toHaveLength(1);
    payload = snap({ available: true, title: 'B' });
    await input.pollNow();
    expect(got).toHaveLength(2);
    input.setPaused(true);
    expect(input.isRunning()).toBe(false);
    input.dispose();
  });
  it('连续 3 次失败后进入退避（10s），成功恢复；stop 后不再请求', async () => {
    vi.useFakeTimers();
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    let calls = 0;
    let fail = true;
    const input = createMediaInput({
      fetchImpl: async () => { calls += 1; if (fail) throw new Error('net'); return { ok: true, json: async () => snap({ available: true, title: 'T' }) }; },
      setIntervalImpl: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length - 1; },
      clearIntervalImpl: () => {},
      onSnapshot: () => {},
      onError: () => {},
    });
    input.start();
    for (let i = 0; i < 3; i++) await input.pollNow();
    expect(intervals.some((i) => i.ms === 10_000)).toBe(true);
    fail = false;
    await input.pollNow();
    input.stop();
    expect(input.isRunning()).toBe(false);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/media-input.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/client/media-input.ts`：
```ts
// client 媒体轮询：仅「当前场景需要媒体」时由 three-renderer 创建；1s 拉快照 + diff 回调。
import type { MediaSessionSnapshot } from '../shared/media.js';

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_BACKOFF_MS = 10_000;
const FAILURES_BEFORE_BACKOFF = 3;
const DIFF_KEYS = ['available', 'reason', 'appId', 'playback', 'title', 'artist', 'album', 'hasThumbnail', 'thumbnailRev'] as const;

export function mediaUrl(pageTitle: string): string {
  return '/wallpapers/now-playing?title=' + encodeURIComponent(pageTitle);
}

export function diffSnapshot(prev: MediaSessionSnapshot | null, next: MediaSessionSnapshot): string[] {
  if (!prev) return ['available', 'reason', 'appId', 'playback', 'title', 'artist', 'album', 'hasThumbnail', 'thumbnailRev'];
  return DIFF_KEYS.filter((k) => prev[k] !== next[k]);
}

export function createMediaInput(opts: MediaInputOptions): MediaInput { /* 见下 */ }
```
`createMediaInput` 具体实现：
```ts
export function createMediaInput(opts: MediaInputOptions): MediaInput {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const fetchImpl = opts.fetchImpl ?? ((url: string) => fetch(url));
  const pageTitle = opts.pageTitle ?? (() => (typeof document !== 'undefined' ? document.title : ''));
  const setIntervalImpl = opts.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = opts.clearIntervalImpl ?? clearInterval;

  let running = false;
  let paused = false;
  let disposed = false;
  let timer: unknown = null;
  let failures = 0;
  let inflight = false;
  let prev: MediaSessionSnapshot | null = null;

  const ensureTimer = (ms: number) => {
    if (timer !== null) clearIntervalImpl(timer);
    timer = setIntervalImpl(() => { void poll(); }, ms);
  };
  const stopTimer = () => {
    if (timer === null) return;
    clearIntervalImpl(timer);
    timer = null;
  };

  const poll = async (): Promise<void> => {
    if (disposed || paused || inflight) return;
    inflight = true;
    try {
      const resp = await fetchImpl(mediaUrl(pageTitle()));
      if (!resp.ok) throw new Error('now-playing http ' + (resp as { status?: number }).status);
      const next = await resp.json();
      if (disposed || paused) return;
      failures = 0;
      if (diffSnapshot(prev, next).length > 0) {
        const old = prev;
        prev = next;
        opts.onSnapshot(next, old);
      }
      if (timer !== null && ...) // 保持 timer 间隔（见下）
    } catch (error) {
      failures += 1;
      opts.onError?.(error);
      if (failures >= FAILURES_BEFORE_BACKOFF) {
        ensureTimer(backoffMs);
      }
    } finally {
      inflight = false;
    }
  };

  return {
    start() {
      if (disposed || running) return;
      running = true;
      ensureTimer(intervalMs);
      void poll();
    },
    stop() {
      running = false;
      stopTimer();
    },
    setPaused(value: boolean) {
      paused = value;
      if (value) stopTimer();
      else if (running && !disposed) { ensureTimer(failures >= FAILURES_BEFORE_BACKOFF ? backoffMs : intervalMs); void poll(); }
    },
    async pollNow() { await poll(); },
    isRunning() { return running && !paused && !disposed; },
    dispose() { disposed = true; running = false; stopTimer(); },
  };
}
```
（实现时把 `...` 注释清掉：成功时若 timer 当前是退避间隔且失败已清零，则 `ensureTimer(intervalMs)` 恢复；用 `let currentIntervalMs` 记录当前间隔避免重复重建。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/media-input.test.ts` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/media-input.ts tests/media-input.test.ts
git commit -m "feat(media): client 媒体轮询总线" -m "- 1s 轮询 + diff 回调；暂停/隐藏/卸载停轮询；连续失败退避 10s" -m "- 纯函数 diff/mediaUrl 可单测"
```

## Task 5: scene.json 多脚本解析（`objectScripts`）+ `collectScriptSources` 改造

**Files:**
- Modify: `src/shared/types.ts`（`SceneObjectBase`：三字段 → `objectScripts`）
- Modify: `src/client/scene-json.ts`（`objectScriptFields` → `objectScriptsField`）
- Modify: `src/client/three-renderer.ts`（`collectScriptSources` 重写，visible 从 `obj.visible.script` 取）
- Test: `tests/scene-json-object-script.test.ts`（按新形状重写）
- Test: `tests/three-renderer.test.ts`（`collectScriptSources` 用例，约:2415）
- Test: `tests/user-bindings.test.ts`（约:201 的 `objectScriptProperties` 断言）

**Interfaces:**
- Produces：
```ts
// src/shared/types.ts
export interface ObjectScriptEntry {
  property: ObjectScriptProperty;
  script: string;
  scriptProperties?: Record<string, unknown>;
}
export interface SceneObjectBase {
  // …既有字段…
  /** 对象级属性脚本（angles/origin/scale/color 可各有一个）；visible.script 走 VisibleBinding。 */
  objectScripts?: ObjectScriptEntry[];
}
```
- 删除 `objectScript` / `objectScriptProperty` / `objectScriptProperties` 三字段（仓内唯一消费方是 `collectScriptSources`，本次一并改）。

- [ ] **Step 1: 写失败测试**

`tests/scene-json-object-script.test.ts` 整体替换为：
```ts
import { describe, expect, it } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';

const s = (objects: unknown[]) => JSON.stringify({ objects });
const SCRIPT = 'export function update(v){ return v; }';

describe('对象属性脚本（objectScripts）', () => {
  it('四个属性各挂脚本时全部收集，顺序 angles/origin/scale/color，保留 scriptproperties', () => {
    const d = parseSceneJson(s([{
      id: 7, name: 'x',
      angles: { script: SCRIPT + '//a', value: '0 0 0' },
      origin: { script: SCRIPT + '//o', scriptproperties: { speed: 2 }, value: '1 2 3' },
      scale: { script: SCRIPT + '//s', value: '1 1 1' },
      color: { script: SCRIPT + '//c', scriptproperties: { tint: { value: 7, user: { name: 'u' } } }, value: '1 1 1' },
    }]));
    const o = d.objects[0] as any;
    expect(o.objectScripts?.map((e: any) => e.property)).toEqual(['angles', 'origin', 'scale', 'color']);
    expect(o.objectScripts?.[1]?.scriptProperties).toEqual({ speed: 2 });
    expect(o.objectScripts?.[3]?.scriptProperties).toEqual({ tint: { value: 7, user: { name: 'u' } } });
  });
  it('无脚本的属性不产出条目；全无 ⇒ objectScripts undefined', () => {
    const d = parseSceneJson(s([
      { id: 1, image: 'models/x.json', angles: '0 0 0', origin: '1 2 3' },
      { id: 2, image: 'models/x.json', scale: { script: SCRIPT } },
    ]));
    expect((d.objects[0] as any).objectScripts).toBeUndefined();
    expect((d.objects[1] as any).objectScripts?.map((e: any) => e.property)).toEqual(['scale']);
  });
});
```

`tests/three-renderer.test.ts` 里该用例改为（新行为）：
```ts
it('collectScriptSources：visible 走 VisibleBinding；text.script 不混入；属性脚本全部收集', () => {
  const desc = parseSceneJson(JSON.stringify({ objects: [
    { id: 1, image: 'models/x.json', visible: { script: 'VISIBLE_SRC', value: true } },
    { id: 2, image: 'models/x.json', angles: { script: 'ANGLES_SRC' }, origin: { script: 'ORIGIN_SRC' } },
    { id: 3, text: { value: 'hi', script: 'TEXT_SRC' }, visible: { script: 'VISIBLE_TEXT', value: true } },
  ] }));
  const out = collectScriptSources(desc);
  expect(out.map((s) => [s.objectId, s.property, s.source])).toEqual([
    [1, undefined, 'VISIBLE_SRC'],
    [2, 'angles', 'ANGLES_SRC'],
    [2, 'origin', 'ORIGIN_SRC'],
    [3, undefined, 'VISIBLE_TEXT'],
  ]);
});
```

`tests/user-bindings.test.ts` 的断言改为：`expect(o.objectScripts?.[0]?.scriptProperties).toEqual({ dayStart: 6 });`（fixture 里 `objectScriptProperties` 改成 `origin: { script, scriptproperties }`）。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/scene-json-object-script.test.ts tests/three-renderer.test.ts tests/user-bindings.test.ts`
Expected: FAIL（`objectScripts` undefined / 旧字段不存在）

- [ ] **Step 3: 实现**

`src/shared/types.ts`：删除 `objectScript/objectScriptProperty/objectScriptProperties`，加入 `ObjectScriptEntry` 与 `objectScripts?: ObjectScriptEntry[]`（注释说明四属性可各一个、visible 走 VisibleBinding）。

`src/client/scene-json.ts`：
```ts
const OBJECT_SCRIPT_PROPS = ['angles', 'origin', 'scale', 'color'] as const;

// 对象属性脚本：四个转换属性可各挂一个脚本（各自 scriptproperties 独立）。
function objectScriptsField(o: Record<string, unknown>): { objectScripts?: ObjectScriptEntry[] } {
  const out: ObjectScriptEntry[] = [];
  for (const property of OBJECT_SCRIPT_PROPS) {
    const v = o[property];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const f = scriptFields(v as { script?: unknown; scriptproperties?: unknown });
    if (!f.script) continue;
    out.push({ property, script: f.script, ...(f.scriptProperties ? { scriptProperties: f.scriptProperties } : {}) });
  }
  return out.length > 0 ? { objectScripts: out } : {};
}
```
把 `const base = { … ...objectScriptFields(o) }` 改为 `...objectScriptsField(o)`，并删除旧 `objectScriptFields` 函数。

`src/client/three-renderer.ts`：
```ts
// 每对象收集：visible.script（VisibleBinding 通道）+ 每个属性脚本（objectScripts）。
// ⚠️ 不能再用 obj.script 当 visible：text 对象的 obj.script 是 text.script（会被 text 运行时消费）。
export function collectScriptSources(desc: SceneDescription): Array<{
  objectId: number; source: string; scriptProperties?: Record<string, unknown>; property?: ObjectScriptProperty;
}> {
  const out: Array<{ objectId: number; source: string; scriptProperties?: Record<string, unknown>; property?: ObjectScriptProperty }> = [];
  for (const obj of desc.objects) {
    if (obj.visible?.kind === 'script' && typeof obj.visible.script === 'string' && obj.visible.script) {
      out.push({
        objectId: obj.id, source: obj.visible.script,
        ...(obj.visible.scriptProperties ? { scriptProperties: obj.visible.scriptProperties } : {}),
      });
    }
    for (const e of obj.objectScripts ?? []) {
      out.push({
        objectId: obj.id, source: e.script, property: e.property,
        ...(e.scriptProperties ? { scriptProperties: e.scriptProperties } : {}),
      });
    }
  }
  return out;
}
```

- [ ] **Step 4: 运行确认通过 + 全量**

Run: `npx vitest run tests/scene-json-object-script.test.ts tests/three-renderer.test.ts tests/user-bindings.test.ts tests/scene-json.test.ts` → PASS
Run: `npm test` → 全绿（若其他测试引用旧字段，按编译错误逐个改到新形状）

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/client/scene-json.ts src/client/three-renderer.ts tests/scene-json-object-script.test.ts tests/three-renderer.test.ts tests/user-bindings.test.ts
git commit -m "feat(scene): 每对象多属性脚本收集" -m "- objectScripts 取代单脚本三字段；visible 脚本统一取 VisibleBinding（修 text.script 覆盖）" -m "- 目标壁纸 11 个属性脚本与 6 个 visible 脚本全部进同一 VM"
```

---

## Task 6: SceneScript VM 媒体事件 + `dispatchMedia` + `thisObject`

**Files:**
- Create: `src/client/scene-timeline.ts`（本 Task 只放类型/接口壳，Task 9/10 填实现）
- Modify: `src/shared/types.ts`（`TimelineProperty`）
- Modify: `src/client/scene-anim.ts`（`AnimPlayback` 可选元数据字段）
- Modify: `src/client/scene-script-vm.ts`（prelude + handlers + dispatchMedia + thisObject + propAnim）
- Modify: `src/client/scene-script-host.ts`（多脚本可见性映射 + media 转发 + applyExternal/read/drainDirty）
- Test: `tests/scene-script-vm.test.ts`（追加）
- Test: `tests/scene-script-host.test.ts`（追加）

**Interfaces:**
- Produces：
```ts
// src/shared/types.ts
export type TimelineProperty = 'alpha' | 'origin' | 'scale' | 'angles' | 'color';

// src/client/scene-timeline.ts（壳）
import type { AnimPlayback } from './scene-anim.js';
import type { TimelineProperty } from '../shared/types.js';
export interface TimelineAnimationSource {
  /** 按对象 + 属性 + 动画名（'' = 当前属性绑定）取播放器；无 ⇒ null（调用方回退 AnimRegistry）。 */
  getByProperty(objectId: number, property: TimelineProperty, name: string): AnimPlayback | null;
  /** 按对象 + 动画 name 取播放器（thisLayer.getAnimation('Title')）。 */
  getByName(objectId: number, name: string): AnimPlayback | null;
}

// scene-script-vm.ts
export type MediaDispatchEvent = 'mediaPlaybackChanged' | 'mediaStatusChanged' | 'mediaPropertiesChanged' | 'mediaThumbnailChanged';
export interface MediaPropertiesPayload { title: string; artist: string; album: string; contentType: string }
export interface MediaThumbnailPayload {
  hasThumbnail: boolean;
  primaryColor: [number, number, number]; secondaryColor: [number, number, number]; tertiaryColor: [number, number, number];
  textColor: [number, number, number]; highContrastColor: [number, number, number];
}
export interface MediaDispatch {
  event: MediaDispatchEvent;
  playback?: number;          // 0 stopped / 1 playing / 2 paused（MediaPlaybackEvent 常量）
  enabled?: boolean;          // mediaStatusChanged
  properties?: MediaPropertiesPayload;
  thumbnail?: MediaThumbnailPayload;
}
// VM 新增：dispatchMedia(dispatch: MediaDispatch): number；updateAll(): Array<{ objectId: number | null; property: ObjectScriptProperty | null; value: unknown }>
// VM options 新增：timeline?: TimelineAnimationSource

// scene-script-host.ts 新增公开方法
mediaPlayback(state: 'stopped' | 'playing' | 'paused'): void;
mediaStatus(enabled: boolean): void;
mediaProperties(props: MediaPropertiesPayload): void;
mediaThumbnail(thumb: MediaThumbnailPayload): void;
applyExternal(writes: Map<number, LayerWrite>): void;
read(objectId: number): LayerWrite;
drainDirty(): Map<number, LayerWrite>;
```
- 0/1/2 常量与 spec 一致（WE 官方 `PLAYBACK_STOPPED=0 / PLAYING=1 / PAUSED=2`）。

- [ ] **Step 1: 写失败测试**

`tests/scene-script-vm.test.ts` 追加：
```ts
it('mediaPlaybackChanged：事件内 thisLayer.visible 写入状态表；MediaPlaybackEvent 常量可用', async () => {
  const { state, anims, userProps } = setup();
  const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
  vm!.load(`
    export function mediaPlaybackChanged(event){
      if (event.state == MediaPlaybackEvent.PLAYBACK_STOPPED) thisLayer.visible = false;
      else thisLayer.visible = true;
    }`);
  expect(vm!.dispatchMedia({ event: 'mediaPlaybackChanged', playback: 0 })).toBe(1);
  expect(state.read(1).visible).toBe(false);
  vm!.dispatchMedia({ event: 'mediaPlaybackChanged', playback: 1 });
  expect(state.read(1).visible).toBe(true);
  vm!.dispose();
});

it('mediaPropertiesChanged / mediaThumbnailChanged：字段与 Vec3 颜色进脚本', async () => {
  const { state, anims, userProps } = setup();
  const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims });
  vm!.load(`
    export function mediaPropertiesChanged(event){
      var L = thisScene.getLayerByID(5); L.alpha = event.title == 'T' ? 0.5 : 0;
    }
    export function mediaThumbnailChanged(event){
      var L = thisScene.getLayerByID(5);
      if (event.hasThumbnail) L.color = new Vec3(event.primaryColor.x, event.primaryColor.y, event.primaryColor.z);
    }`);
  vm!.dispatchMedia({ event: 'mediaPropertiesChanged', properties: { title: 'T', artist: 'A', album: '', contentType: 'music' } });
  expect(state.read(5).alpha).toBeCloseTo(0.5);
  vm!.dispatchMedia({ event: 'mediaThumbnailChanged', thumbnail: {
    hasThumbnail: true, primaryColor: [1, 0, 0], secondaryColor: [0, 1, 0], tertiaryColor: [0, 0, 1],
    textColor: [1, 1, 1], highContrastColor: [0, 0, 0],
  } });
  expect(state.read(5).color).toEqual([1, 0, 0]);
  vm!.dispose();
});

it('thisObject.getAnimation()：事件里播放属性动画不抛错；无时间线源时跑 dummy 播放器', async () => {
  const { state, anims, userProps } = setup();
  const played: string[] = [];
  const vm = await SceneScriptVm.create({ userProperties: userProps, state, anims, timeline: {
    getByProperty: (id, prop) => (played.push(`${id}:${prop}`), { play: () => played.push('play'), pause() {}, stop() {}, isPlaying: () => false, setFrame() {}, getFrame: () => 0 } as any),
    getByName: () => null,
  } });
  vm!.load(`export function mediaThumbnailChanged(event){ thisObject.getAnimation().play(); }`);
  expect(vm!.dispatchMedia({ event: 'mediaThumbnailChanged', thumbnail: { hasThumbnail: false, primaryColor: [0,0,0], secondaryColor: [0,0,0], tertiaryColor: [0,0,0], textColor: [0,0,0], highContrastColor: [0,0,0] } })).toBe(1);
  expect(played).toContain('play');
  expect(vm!.activeCount).toBe(1); // 没抛错、脚本仍启用
  vm!.dispose();
});
```

`tests/scene-script-host.test.ts` 追加：
```ts
it('多脚本：visible 脚本返回布尔写 visible；同对象属性脚本写角度且不参与 visible', async () => {
  const host = await SceneScriptHost.create({ userProperties: {}, scripts: [
    { objectId: 1, source: 'export function update(v){ return false; }' },
    { objectId: 1, source: 'export function update(v){ return new Vec3(30, 0, 0); }', property: 'angles' },
  ] });
  const dirty = host!.tick(1 / 60);
  expect(dirty.get(1)?.visible).toBe(false);
  expect(dirty.get(1)?.angles).toEqual([30, 0, 0]);
  host!.dispose();
});

it('media 事件转发到对应 handler', async () => {
  const host = await SceneScriptHost.create({ userProperties: {}, scripts: [
    { objectId: 2, source: 'export function mediaStatusChanged(e){ thisLayer.alpha = e.enabled ? 1 : 0; }' },
  ] });
  host!.mediaStatus(false);
  expect(host!.read(2).alpha).toBe(0);
  const dirty = host!.drainDirty();
  expect(dirty.get(2)?.alpha).toBe(0);
  host!.dispose();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/scene-script-vm.test.ts tests/scene-script-host.test.ts`
Expected: FAIL（`dispatchMedia is not a function` / `timeline` 未支持）

- [ ] **Step 3: 实现**

`src/shared/types.ts` 加 `export type TimelineProperty = 'alpha' | 'origin' | 'scale' | 'angles' | 'color';`
`src/client/scene-anim.ts` 的 `AnimPlayback` 增加可选只读元数据：`fps?: number; frameCount?: number; duration?: number; name?: string; rate?: number;`（不改既有实现）。
`src/client/scene-timeline.ts` 新建（只放上列类型与接口）。
`src/client/scene-anim.ts` `AnimPlayback` interface 同步（在文件 `:103` 附近追加字段）。

`src/client/scene-script-vm.ts`：
1) PRELUDE 在 `__mkAnim` 之后追加：
```js
// 媒体事件类常量（WE 官方数值：STOPPED=0 / PLAYING=1 / PAUSED=2）。
var MediaPlaybackEvent = { PLAYBACK_STOPPED: 0, PLAYBACK_PLAYING: 1, PLAYBACK_PAUSED: 2 };

// 属性/命名时间线动画播放器：与本文件 __mkAnim 的区别是走时间线源（Task 9/10 的 TimelineRuntime）。
var __propAnimCache = {};
function __mkPropAnim(key, property, name) {
  var k = key + '|' + property + '|' + name;
  if (__propAnimCache[k]) return __propAnimCache[k];
  __propAnimCache[k] = {
    play: function () { __host.propAnimPlay(key, property, name); },
    pause: function () { __host.propAnimPause(key, property, name); },
    stop: function () { __host.propAnimStop(key, property, name); },
    isPlaying: function () { return __host.propAnimIsPlaying(key, property, name); },
    setFrame: function (f) { __host.propAnimSetFrame(key, property, name, f); },
    getFrame: function () { return __host.propAnimGetFrame(key, property, name); },
    get rank() { return 0; },
    get rate() { return __host.propAnimRate(key, property, name); },
    set rate(v) { __host.propAnimSetRate(key, property, name, v); }
  };
  return __propAnimCache[k];
}
// thisObject：当前脚本所属对象（属性脚本带当前属性；visible/text 脚本 property 为空串）。
var __thisObjectCache = {};
function __mkThisObject(key, property) {
  var ck = key + '|' + property;
  if (__thisObjectCache[ck]) return __thisObjectCache[ck];
  var layer = __mkLayer(key);
  __thisObjectCache[ck] = new Proxy(layer, {
    get: function (t, prop) {
      if (prop === 'getAnimation') {
        return function (name) { return __mkPropAnim(key, property, name ? String(name) : ''); };
      }
      return t[prop];
    }
  });
  return __thisObjectCache[ck];
}
Object.defineProperty(globalThis, 'thisObject', {
  get: function () { return __mkThisObject(__host.currentLayerKey(), __host.currentProperty()); },
  configurable: true
});
```
2) `SceneScriptVmOptions` 加 `timeline?: TimelineAnimationSource;`；字段 `private readonly timeline: TimelineAnimationSource | null;`。
3) `LoadedModule` 加 `media: { playback: QuickJSHandle | null; status: ...; properties: ...; thumbnail: ... };`（在 `handles.push` 处一并收）。
4) `load()` 的返回对象追加：
```ts
mediaPlaybackChanged: (typeof mediaPlaybackChanged === 'function') ? mediaPlaybackChanged : null,
mediaStatusChanged: (typeof mediaStatusChanged === 'function') ? mediaStatusChanged : null,
mediaPropertiesChanged: (typeof mediaPropertiesChanged === 'function') ? mediaPropertiesChanged : null,
mediaThumbnailChanged: (typeof mediaThumbnailChanged === 'function') ? mediaThumbnailChanged : null,
```
并 `grab` 这四个函数。
5) `installPrelude` 注册新原语：
```ts
define('currentProperty', () => ctx.newString(this.currentProperty));
const propPlayback = (k: QuickJSHandle, p: QuickJSHandle, n: QuickJSHandle) =>
  this.propAnim(ctx.getString(k), ctx.getString(p), ctx.getString(n));
define('propAnimPlay', (k, p, n) => { propPlayback(k, p, n).play(); });
define('propAnimPause', (k, p, n) => { propPlayback(k, p, n).pause(); });
define('propAnimStop', (k, p, n) => { propPlayback(k, p, n).stop(); });
define('propAnimIsPlaying', (k, p, n) => (propPlayback(k, p, n).isPlaying() ? ctx.true : ctx.false));
define('propAnimSetFrame', (k, p, n, f) => { propPlayback(k, p, n).setFrame(ctx.getNumber(f)); });
define('propAnimGetFrame', (k, p, n) => ctx.newNumber(propPlayback(k, p, n).getFrame()));
define('propAnimRate', (k, p, n) => ctx.newNumber(propPlayback(k, p, n).rate ?? 1));
define('propAnimSetRate', (k, p, n, r) => { const pb = propPlayback(k, p, n); if (typeof r === 'number') pb.rate = ctx.getNumber(r); });
```
6) 新增字段/方法：
```ts
private currentProperty = '';
private readonly timeline;
private propAnimCache = new Map<string, AnimPlayback>();

private propAnim(layerKey: string, property: string, name: string): AnimPlayback {
  const key = `${layerKey}|${property}|${name}`;
  const hit = this.propAnimCache.get(key);
  if (hit) return hit;
  const m = /^id:(\d+)$/.exec(layerKey);
  const objectId = m ? Number(m[1]) : -1;
  const tl = objectId >= 0 ? this.timeline : null;
  const pb = (tl && (property ? tl.getByProperty(objectId, property as TimelineProperty, name) : null))
    ?? (tl && name ? tl.getByName(objectId, name) : null)
    ?? this.anims.get(layerKey, name || property);
  this.propAnimCache.set(key, pb);
  return pb;
}
```
7) `updateAll()` 返回结构化结果（并保留 clickAll 不变）：
```ts
updateAll(): Array<{ objectId: number | null; property: ObjectScriptProperty | null; value: unknown }> {
  const out: Array<{ objectId: number | null; property: ObjectScriptProperty | null; value: unknown }> = [];
  for (const m of this.modules) {
    this.currentProperty = m.property ?? '';
    out.push({ objectId: m.objectId, property: m.property, value: this.callOne(m, m.update, 'value') });
  }
  return out;
}
```
8) `dispatchMedia(dispatch: MediaDispatch): number`：
```ts
dispatchMedia(dispatch: MediaDispatch): number {
  const ctx = this.ctx;
  let called = 0;
  for (const m of this.modules) {
    const fn = dispatch.event === 'mediaPlaybackChanged' ? m.media.playback
      : dispatch.event === 'mediaStatusChanged' ? m.media.status
        : dispatch.event === 'mediaPropertiesChanged' ? m.media.properties : m.media.thumbnail;
    if (!m.active || !fn) continue;
    this.currentKey = m.layerKey;
    this.currentProperty = m.property ?? '';
    this.budget = this.stepBudget;
    const ev = this.buildMediaEvent(dispatch);
    const res = ctx.callFunction(fn, m.instance, ev);
    ev.dispose();
    if (res.error) {
      const msg = this.errorText(res.error); res.error.dispose();
      m.active = false;
      this.warn(`SceneScript 抛错，已停用该脚本（${m.label}）：${msg}`);
      continue;
    }
    res.value.dispose();
    called += 1;
  }
  return called;
}

private buildMediaEvent(d: MediaDispatch): QuickJSHandle {
  const ctx = this.ctx;
  const obj = ctx.newObject();
  const str = (k: string, v: string) => { const h = ctx.newString(v); ctx.setProp(obj, k, h); h.dispose(); };
  const num = (k: string, v: number) => { const h = ctx.newNumber(v); ctx.setProp(obj, k, h); h.dispose(); };
  const bool = (k: string, v: boolean) => ctx.setProp(obj, k, v ? ctx.true : ctx.false);
  const vec = (k: string, v: [number, number, number]) => {
    const o = ctx.newObject();
    for (const [axis, n] of [['x', v[0]], ['y', v[1]], ['z', v[2]]] as const) { const h = ctx.newNumber(n); ctx.setProp(o, axis, h); h.dispose(); }
    ctx.setProp(obj, k, o); o.dispose();
  };
  if (d.event === 'mediaPlaybackChanged') num('state', d.playback ?? 0);
  else if (d.event === 'mediaStatusChanged') bool('enabled', !!d.enabled);
  else if (d.event === 'mediaPropertiesChanged') {
    const p = d.properties ?? { title: '', artist: '', album: '', contentType: '' };
    str('title', p.title); str('artist', p.artist); str('album', p.album);
    str('contentType', p.contentType); str('albumTitle', p.album); str('subTitle', '');
    str('albumArtist', p.artist); str('genres', '');
  } else {
    const t = d.thumbnail!;
    bool('hasThumbnail', t.hasThumbnail);
    vec('primaryColor', t.primaryColor); vec('secondaryColor', t.secondaryColor); vec('tertiaryColor', t.tertiaryColor);
    vec('textColor', t.textColor); vec('highContrastColor', t.highContrastColor);
  }
  return obj;
}
```
9) `dispose()` 里清 `propAnimCache`；`clickAll` 保持。

`src/client/scene-script-host.ts`：
```ts
// 字段
private readonly scriptMeta: Array<{ objectId: number; property?: ObjectScriptProperty }>;
// create 后构造（scripts 过滤后与 vm.load 一一对应：load 失败的脚本 VM 不会 push module，
// 因此 tick 时以 vm.updateAll() 返回的 objectId/property 为准，不依赖下标）。
constructor(...){ this.scriptMeta = scripts.map((s) => ({ objectId: s.objectId, ...(s.property ? { property: s.property } : {}) })); }
// 注意：构造函数签名改为把 scripts 传入；tick 里直接使用 results 自带元数据：

tick(dt: number): Map<number, LayerWrite> {
  if (!this.vm) return new Map();
  this.vm.setFrametime(dt);
  this.anims.tick(dt);
  for (const r of this.vm.updateAll()) {
    if (r.property === null && r.objectId !== null && typeof r.value === 'boolean') {
      this.state.write(r.objectId, { visible: r.value });
    }
  }
  return this.state.takeDirty();
}

mediaPlayback(state: 'stopped' | 'playing' | 'paused'): void {
  this.vm?.dispatchMedia({ event: 'mediaPlaybackChanged', playback: state === 'playing' ? 1 : state === 'paused' ? 2 : 0 });
}
mediaStatus(enabled: boolean): void { this.vm?.dispatchMedia({ event: 'mediaStatusChanged', enabled }); }
mediaProperties(props: MediaPropertiesPayload): void { this.vm?.dispatchMedia({ event: 'mediaPropertiesChanged', properties: props }); }
mediaThumbnail(thumb: MediaThumbnailPayload): void { this.vm?.dispatchMedia({ event: 'mediaThumbnailChanged', thumbnail: thumb }); }
applyExternal(writes: Map<number, LayerWrite>): void { for (const [id, patch] of writes) this.state.write(id, patch); }
read(objectId: number): LayerWrite { return this.state.read(objectId); }
drainDirty(): Map<number, LayerWrite> { return this.state.takeDirty(); }
```
（create() 里把 `vm.load` 的 property 透传已存在；构造器需要接收 scripts 以保留元数据——实现时把 `new SceneScriptHost(anims, state, vm, objectIds)` 换为 `new SceneScriptHost(anims, state, vm)`，删掉 objectIds 字段。）

- [ ] **Step 4: 运行确认通过 + 全量**

Run: `npx vitest run tests/scene-script-vm.test.ts tests/scene-script-host.test.ts tests/scene-json*.test.ts` → PASS
Run: `npm test` → 全绿（`updateAll` 形状变更会影响既有断言：按新结构 `[{objectId, property, value}]` 更新）

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/client/scene-anim.ts src/client/scene-timeline.ts src/client/scene-script-vm.ts src/client/scene-script-host.ts tests/scene-script-vm.test.ts tests/scene-script-host.test.ts
git commit -m "feat(scene): SceneScript media 事件与 thisObject" -m "- prelude 增 MediaPlaybackEvent 常量、thisObject.getAnimation()、时间线播放器桥" -m "- dispatchMedia 四类事件；updateAll 带 objectId/property；host 多脚本可见性映射"
```

---

## Task 7: 文本脚本媒体事件 + three-renderer 媒体编排（**白框修复**）+ 设置/面板 + e2e

**Files:**
- Modify: `src/client/text-script.ts`（事件 handler + runtime 广播 + 绑定集合）
- Modify: `src/client/media-input.ts`（追加 `applyMediaSnapshot` 纯函数 + `sceneNeedsMedia`）
- Modify: `src/client/three-renderer.ts`（媒体编排 + `setMediaIntegration`）
- Modify: `src/client/wallpaper-controller.ts`（`SceneRendererLike.setMediaIntegration?`）
- Modify: `src/client/index.ts`（`applyRuntimeSettings` 下发）
- Modify: `src/client/types.ts` + `src/client/settings.ts`（`mediaIntegrationEnabled`）
- Modify: `src/client/settings-section.tsx`（显示效果组开关）
- Create: `e2e/harness/harness-media-entry.mjs`
- Create: `e2e/verify/verify-media-layer.mjs`
- Modify: `package.json`（`"e2e:media": "node e2e/verify/verify-media-layer.mjs"`）
- Test: `tests/text-script.test.ts`、`tests/media-input.test.ts`、`tests/client-settings.test.ts`（如断言字段）

**Interfaces:**
- Produces：
```ts
// text-script.ts
export interface MediaPropertiesPayload { title: string; artist: string; album: string; contentType: string }
export interface TextScriptBinding {
  update(): string | null;
  dispatchMediaProperties(props: MediaPropertiesPayload): void;
  dispose(): void;
}
export interface TextScriptRuntime {
  bind(script: string, scriptProperties: Record<string, unknown>, initialValue: string): TextScriptBinding | null;
  dispatchMediaProperties(props: MediaPropertiesPayload): void;
  dispose(): void;
}

// media-input.ts
export interface MediaThumbnailEventPayload {
  hasThumbnail: boolean; rev: number;
  palette: MediaPalette;
}
export interface MediaDispatchSink {
  playback(state: 'stopped' | 'playing' | 'paused'): void;
  status(enabled: boolean): void;
  properties(props: MediaPropertiesPayload): void;
  thumbnail(payload: MediaThumbnailEventPayload): void;
}
export function applyMediaSnapshot(prev: MediaSessionSnapshot | null, next: MediaSessionSnapshot, sink: MediaDispatchSink): void;
export function sceneNeedsMedia(desc: SceneDescription): boolean;

// three-renderer 返回对象新增（RendererLike）
setMediaIntegration?(enabled: boolean): void;
```

- [ ] **Step 1: 写失败测试**

`tests/text-script.test.ts` 追加：
```ts
it('mediaPropertiesChanged 事件更新内部变量；update() 下一帧产出新文本', async () => {
  const rt = await getTextScriptRuntime();
  const b = rt!.bind(`
    var mediaData = '';
    export function update(v){ return mediaData; }
    export function mediaPropertiesChanged(e){ mediaData = e.title + ' / ' + e.artist; }`,
    {}, '');
  expect(b).not.toBeNull();
  expect(b!.update()).toBe('');
  rt!.dispatchMediaProperties({ title: '歌', artist: '手', album: '', contentType: 'music' });
  expect(b!.update()).toBe('歌 / 手');
  b!.dispose();
});
```

`tests/media-input.test.ts` 追加：
```ts
import { applyMediaSnapshot, sceneNeedsMedia } from '../src/client/media-input.js';
import { parseSceneJson } from '../src/client/scene-json.js';

it('applyMediaSnapshot：首次/切歌/停止的事件顺序与去重', () => {
  const log: string[] = [];
  const sink = {
    playback: (s: string) => log.push('playback:' + s),
    status: (e: boolean) => log.push('status:' + e),
    properties: (p: any) => log.push('props:' + p.title),
    thumbnail: (t: any) => log.push('thumb:' + t.hasThumbnail),
  };
  const playing = { ...emptyMediaSnapshot('ok', 1), available: true, playback: 'playing' as const, title: 'T', artist: 'A', hasThumbnail: true, thumbnailRev: 1 };
  applyMediaSnapshot(null, playing, sink);
  expect(log).toEqual(['status:true', 'playback:playing', 'props:T', 'thumb:true']);
  log.length = 0;
  applyMediaSnapshot(playing, { ...playing, positionMs: 5 }, sink);
  expect(log).toEqual([]);
  applyMediaSnapshot(playing, { ...playing, playback: 'stopped', title: '' }, sink);
  expect(log).toEqual(['playback:stopped']);
});

it('sceneNeedsMedia：只有声明 media* 脚本/实例用户纹理时为 true', () => {
  const plain = parseSceneJson(JSON.stringify({ objects: [{ id: 1, image: 'models/x.json' }] }));
  expect(sceneNeedsMedia(plain)).toBe(false);
  const media = parseSceneJson(JSON.stringify({ objects: [{ id: 1, image: 'models/x.json', visible: { script: 'export function mediaPlaybackChanged(e){ thisLayer.visible=false; }', value: true } }] }));
  expect(sceneNeedsMedia(media)).toBe(true);
  const text = parseSceneJson(JSON.stringify({ objects: [{ id: 2, text: { value: 'x', script: 'export function mediaPropertiesChanged(e){}' } }] }));
  expect(sceneNeedsMedia(text)).toBe(true);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/text-script.test.ts tests/media-input.test.ts`
Expected: FAIL（`dispatchMediaProperties` / `applyMediaSnapshot` 不存在）

- [ ] **Step 3: 实现**

`src/client/text-script.ts`：
- `TextScriptBinding` / `TextScriptRuntime` 接口按上列扩展。
- `QuickJSTextRuntime` 增加 `private readonly active = new Set<QuickJSTextRuntimeBinding>();`（binding 内部类型）。
- `bind` 的 eval 返回对象改为：
```ts
return (typeof update === 'function') ? {
  update: update,
  mediaPropertiesChanged: (typeof mediaPropertiesChanged === 'function') ? mediaPropertiesChanged : null,
} : null;
```
- 抓 `mediaPropertiesChanged` 句柄；binding 增加方法：
```ts
dispatchMediaProperties(props: MediaPropertiesPayload): void {
  if (disposed || !mediaFn) return;
  this.resetBudget();
  const ev = ctx.newObject();
  for (const key of ['title', 'artist', 'album', 'contentType'] as const) {
    const h = ctx.newString(props[key] ?? ''); ctx.setProp(ev, key, h); h.dispose();
  }
  // WE 的 MediaPropertiesEvent 还有 albumTitle/subTitle/albumArtist/genres：全部给空串，
  // 脚本读到也不会 undefined。
  for (const key of ['albumTitle', 'subTitle', 'albumArtist', 'genres']) ctx.setProp(ev, key, ctx.newString(''));
  const out = ctx.callFunction(mediaFn, ctx.undefined, ev);
  ev.dispose();
  if (out.error) { out.error.dispose(); return; } // 事件失败只丢该事件，不打断每帧 update
  out.value.dispose();
}
```
- binding `dispose()` 从 `active` 移除；runtime：
```ts
dispatchMediaProperties(props: MediaPropertiesPayload): void {
  for (const b of [...this.active]) b.dispatchMediaProperties(props);
}
```
（注意既要 update 也要事件 handler 才 bind：现有 bind 只要求 update；目标壁纸 text 脚本两者都有。保持「无 update 返回 null」不变。）

`src/client/media-input.ts` 追加：
```ts
import type { MediaPalette, MediaSessionSnapshot } from '../shared/media.js';
import type { SceneDescription } from '../shared/types.js';

const NEUTRAL_PALETTE: MediaPalette = {
  primary: [0, 0, 0], secondary: [0, 0, 0], tertiary: [0, 0, 0], text: [1, 1, 1], highContrast: [1, 1, 1],
};
export const NEUTRAL_MEDIA_PALETTE = NEUTRAL_PALETTE;

export function applyMediaSnapshot(prev: MediaSessionSnapshot | null, next: MediaSessionSnapshot, sink: MediaDispatchSink): void {
  const changed = diffSnapshot(prev, next);
  if (changed.length === 0) return;
  if (prev === null) sink.status(true); // 首次快照 = 媒体集成已启用
  if (!next.available) {
    sink.playback('stopped');
    return;
  }
  if (changed.includes('playback')) sink.playback(next.playback);
  if (changed.includes('title') || changed.includes('artist') || changed.includes('album')) {
    sink.properties({ title: next.title, artist: next.artist, album: next.album, contentType: next.contentType });
  }
  if (changed.includes('thumbnailRev') || changed.includes('hasThumbnail')) {
    sink.thumbnail({ hasThumbnail: next.hasThumbnail, rev: next.thumbnailRev, palette: NEUTRAL_PALETTE });
  }
}

const MEDIA_SCRIPT_RE = /mediaPlaybackChanged|mediaStatusChanged|mediaPropertiesChanged|mediaThumbnailChanged|MediaPlaybackEvent/;
export function sceneNeedsMedia(desc: SceneDescription): boolean {
  for (const obj of desc.objects) {
    if (obj.visible?.script && MEDIA_SCRIPT_RE.test(obj.visible.script)) return true;
    for (const e of obj.objectScripts ?? []) if (MEDIA_SCRIPT_RE.test(e.script)) return true;
    const textScript = obj.kind === 'text' ? obj.script : undefined;
    if (typeof textScript === 'string' && MEDIA_SCRIPT_RE.test(textScript)) return true;
  }
  return false;
}
```
（`MediaPropertiesPayload` 类型从 text-script 导入会形成 client→client 依赖，允许；若担心循环，定义在 media-input.ts 并让 text-script 导入——二选一，实现时保持单一来源：**定义在 `src/shared/media.ts`** 更稳。计划采用 shared：`MediaPropertiesPayload` 放 shared/media.ts，Task 6 已引用的话统一改。）

`src/client/three-renderer.ts`：
1) 模块级状态（`currentScriptHost` 附近）：
```ts
let currentMedia: MediaInput | null = null;
let mediaIntegrationEnabled = true;
```
2) teardown（`:425-468` 内）：`currentMedia?.dispose(); currentMedia = null;`（放在 `currentScriptHost?.dispose()` 之前）。
3) 渲染装配：在 `currentScriptHost` 创建完成、日志块之后（`:1147` 附近）：
```ts
// ── 媒体集成：初始事件（无会话 = stopped，立即隐藏媒体层，避免白框闪烁）──────
const mediaNeeded = sceneNeedsMedia(desc);
if (mediaNeeded && currentScriptHost) {
  const host = currentScriptHost;
  const bindings = currentScriptBindings;
  const lookup = (objectId: number) => {
    const obj = result.player.displayObject(objectId);
    return obj ? { object: obj, sceneW: desc.orthogonal.width, sceneH: desc.orthogonal.height } : undefined;
  };
  const sink: MediaDispatchSink = {
    playback: (s) => host.mediaPlayback(s),
    status: (enabled) => host.mediaStatus(enabled),
    properties: (p) => { host.mediaProperties(p); for (const b of bindings) b.dispatchMediaProperties(p); },
    thumbnail: (t) => host.mediaThumbnail({
      hasThumbnail: t.hasThumbnail,
      primaryColor: t.palette.primary, secondaryColor: t.palette.secondary, tertiaryColor: t.palette.tertiary,
      textColor: t.palette.text, highContrastColor: t.palette.highContrast,
    }),
  };
  host.mediaStatus(mediaIntegrationEnabled);
  host.mediaPlayback('stopped');
  applyLayerState(host.drainDirty(), lookup); // 首帧前落地初始派发（媒体层立即隐藏）
  const input = createMediaInput({
    pageTitle: () => (typeof document !== 'undefined' ? document.title : ''),
    onSnapshot: (next, prev) => { if (currentMedia === input && !contextLost) applyMediaSnapshot(prev, next, sink); },
    onError: () => {},
  });
  currentMedia = input;
  input.setPaused(paused || !mediaIntegrationEnabled);
  if (mediaIntegrationEnabled && !paused) input.start();
}
```
4) 返回对象新增：
```ts
setMediaIntegration(enabled: boolean) {
  mediaIntegrationEnabled = enabled;
  const host = currentScriptHost;
  if (!host) return;
  host.mediaStatus(enabled);
  if (!enabled) {
    host.mediaPlayback('stopped');
    currentMedia?.stop();
    const loaded = current;
    if (loaded) {
      applyLayerState(host.drainDirty(), (objectId) => {
        const obj = loaded.player.displayObject(objectId);
        return obj ? { object: obj, sceneW: 0, sceneH: 0 } : undefined;
      });
    }
  } else {
    currentMedia?.setPaused(false);
    currentMedia?.start();
  }
},
```
（lookup 用 `sceneW/sceneH` 必须传真实值：从 `current` 的 desc 拿不到，用闭包保存的 `desc`——实现时在 render 内构造 `mediaLookup` 具名函数并在 setMediaIntegration 里复用；不要在 setMediaIntegration 里临时写 0。）
5) `setPaused` 内追加：`currentMedia?.setPaused(value || !mediaIntegrationEnabled);`（暂停时停轮询）。
6) `render()` 开头复位：`currentMedia?.dispose(); currentMedia = null;`（teardown 已做，幂等即可）。

`src/client/wallpaper-controller.ts` `SceneRendererLike` 追加：
```ts
  // 媒体集成开关（面板即时生效；关闭后媒体图层隐藏且停轮询）。
  setMediaIntegration?(enabled: boolean): void;
```
`src/client/types.ts` `ClientSettings` 追加 `mediaIntegrationEnabled: boolean;`
`src/client/settings.ts` `DEFAULTS` 追加 `mediaIntegrationEnabled: true,`
`src/client/index.ts` `applyRuntimeSettings` 追加：
```ts
    sceneRenderer.setMediaIntegration?.(s.mediaIntegrationEnabled);
```
`src/client/settings-section.tsx` 显示效果组（`soundEnabled` 行后）追加：
```tsx
            {/* 媒体集成：Windows SMTC 只读；数据仅内存、不落盘、不上传 */}
            <div className="wss-sound-row">
              <label className="wss-glow-row">
                <input
                  type="checkbox"
                  className="wss-media-integration"
                  checked={settings.mediaIntegrationEnabled}
                  onChange={(e) => applyRuntime({ mediaIntegrationEnabled: e.target.checked })}
                />
                媒体集成（显示本机播放的歌曲封面/歌名）
              </label>
            </div>
```

**e2e harness 入口** `e2e/harness/harness-media-entry.mjs`：以本地临时探针 `research/_wp3797-entry.mjs` 为骨架（若不存在则按下面要点新写）：只用 `lib/client/*`（esbuild 打包），暴露 `window.__ready/__logs/__player/__objectRect/__objectMaterialInfo/__listObjects/__hideObject`，`createThreeSceneRenderer().render(id, canvas)`（1600×900 canvas，`id` 来自 query）；console 镜像与 `ThreeScenePlayer.prototype` 补丁捕获 `__player` 的代码逐字参考 `e2e/harness/harness-text-clock-entry.mjs:20-104`。

**e2e 验证脚本** `e2e/verify/verify-media-layer.mjs`：以本地临时探针 `research/_wp3797-verify.mjs` 为骨架（若不存在，按 `e2e/verify/verify-text-clock-layer.mjs` 的「复刻 host 三条资源路由 + Edge CDP」结构新写），差异：
1) server 追加 mock 路由（不 spawn PowerShell）：
```js
let mediaStage = { available: false, reason: 'no-session', playback: 'stopped', title: '', artist: '', album: '', thumbnailRev: 0 };
let artBytes = null;
// handler('/wallpapers/now-playing') → json 200 { appId:'spotify.exe', contentType:'music', positionMs:1, durationMs:2,
//   at:1, hasThumbnail: !!artBytes, ...mediaStage }
// handler('/wallpapers/now-playing/thumbnail') → 200 artBytes（Content-Type: image/png）或 404
```
素材图：用 `e2e/lib/png-encode.mjs` 生成 32×32 洋红 PNG（导出的编码函数按该文件实际签名调用；若只有 encode 内部函数则在该脚本内联 32×32 RGBA → PNG 的 20 行编码）。
2) 判据（都在 1600×900 canvas 内，复用 `research/_find_whitebox` 的区域）：
   - `[1]` 无会话阶段：`白块区域 x∈[1150,1250] y∈[280,360]` 内三通道全 ≥250 的像素数 **= 0**（修复前 ≈ 60×70 = 4200）；
   - `[2]` `mediaStage` 改为 playing + artBytes 后等 1.5s：封面区域 `x∈[1160,1245] y∈[285,360]` 内洋红像素（R>200,G<80,B>200）**> 200**；
   - `[3]` `__objectMaterialInfo(38).mapSize?.[0] > 4`（歌名文本画布非空）且同 39；
   - `[4]` `mediaStage` 改回 stopped 后等 1.5s：`__player.displayObject(35).visible === false` 且 `displayObject(45).visible === false`；
   - 退出码 0/1，打印每条判据数字。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/text-script.test.ts tests/media-input.test.ts tests/client-settings.test.ts` → PASS
Run: `npm run build`（tsc 出 `lib/`）→ PASS
Run: `npm run e2e:media` → 判据 [1] 先红（此 Task 已修复白框，应为绿）——若 harness/素材缺文件先补齐再跑
Run: `npm run verify:arch` → PASS

- [ ] **Step 5: 提交**

```bash
git add src/client/text-script.ts src/client/media-input.ts src/client/three-renderer.ts src/client/wallpaper-controller.ts src/client/index.ts src/client/types.ts src/client/settings.ts src/client/settings-section.tsx e2e/harness/harness-media-entry.mjs e2e/verify/verify-media-layer.mjs package.json tests/text-script.test.ts tests/media-input.test.ts
git commit -m "feat(media): 媒体事件编排与白框修复" -m "- 装配即派发 status+stopped，媒体层首帧隐藏；1s 轮询驱动 playback/properties 事件" -m "- text 脚本接 mediaPropertiesChanged；面板开关/运行期下发；e2e 无会话白块判据"
```

## Task 8: 实例纹理 `$mediaThumbnail` + 主色提取 + 封面绑定

**Files:**
- Modify: `src/shared/types.ts`（`SceneImageObject.instance`）
- Modify: `src/client/scene-json.ts`（解析 instance）
- Create: `src/client/media-palette.ts`
- Create: `src/client/media-texture.ts`
- Modify: `src/client/scene-assets.ts`（`resolveImageAssets` 返回 `mediaThumbnail` 标记 + `instance.textures` 覆盖）
- Modify: `src/client/three-renderer.ts`（封面纹理源 + 快照缩略图拉取/解码/主色 + 派发真实调色板）
- Modify: `e2e/verify/verify-media-layer.mjs`（追加封面判据 [2]）
- Test: `tests/scene-json.test.ts`（instance 解析）、`tests/media-palette.test.ts`、`tests/scene-assets.test.ts`（mediaThumbnail 标记）

**Interfaces:**
- Produces：
```ts
// shared/types.ts（SceneImageObject 追加）
instance?: { textures?: string[]; usertextures?: Array<{ name: string; type: string }> };

// scene-assets.ts（返回值扩展）
resolveImageAssets(...): Promise<{ texture: THREE.Texture | null; puppetPath: string | null; spriteSheet: boolean; mediaThumbnail: boolean }>;

// media-palette.ts
export function paletteFromPixels(width: number, height: number, rgba: Uint8ClampedArray): MediaPalette;
export async function paletteFromImage(source: ImageBitmap | HTMLImageElement): Promise<MediaPalette>;

// media-texture.ts
export interface MediaThumbnailTextureSource {
  readonly texture: THREE.Texture;
  hasImage(): boolean;
  setImage(image: ImageBitmap | null): void;
  dispose(): void;
}
export function createMediaThumbnailTextureSource(): MediaThumbnailTextureSource;
```

- [ ] **Step 1: 写失败测试**

`tests/media-palette.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { paletteFromPixels } from '../src/client/media-palette.js';

const solid = (r: number, g: number, b: number, n = 32 * 32) => {
  const data = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return data;
};

describe('paletteFromPixels', () => {
  it('纯色图：primary/secondary/tertiary 都是该色；highContrast 取黑或白', () => {
    const p = paletteFromPixels(32, 32, solid(255, 0, 0));
    for (const rgb of [p.primary, p.secondary, p.tertiary]) {
      expect(rgb[0]).toBeCloseTo(1, 2); expect(rgb[1]).toBeCloseTo(0, 2); expect(rgb[2]).toBeCloseTo(0, 2);
    }
    expect([[0, 0, 0], [1, 1, 1]]).toContainEqual(p.highContrast);
  });
  it('黑/白边界：纯白图 primary≈白、highContrast=黑', () => {
    const p = paletteFromPixels(32, 32, solid(255, 255, 255));
    expect(p.primary[0]).toBeCloseTo(1, 2);
    expect(p.highContrast).toEqual([0, 0, 0]);
    const black = paletteFromPixels(32, 32, solid(0, 0, 0));
    expect(black.highContrast).toEqual([1, 1, 1]);
  });
  it('两色图：主色覆盖面积更大者', () => {
    const data = new Uint8ClampedArray(32 * 32 * 4);
    for (let i = 0; i < 32 * 32; i++) {
      const red = i % 4 !== 0;
      data[i * 4] = red ? 200 : 20; data[i * 4 + 1] = 20; data[i * 4 + 2] = 20; data[i * 4 + 3] = 255;
    }
    expect(paletteFromPixels(32, 32, data).primary[0]).toBeGreaterThan(0.5);
  });
  it('全透明/空像素 ⇒ 中性调色板（不抛错）', () => {
    const p = paletteFromPixels(4, 4, new Uint8ClampedArray(4 * 4 * 4));
    expect(p.primary).toEqual([0, 0, 0]);
  });
});
```

`tests/scene-json.test.ts` 追加：
```ts
it('image 对象 instance：textures 与 usertextures 被解析；畸形字段忽略', () => {
  const d = parseSceneJson(JSON.stringify({ objects: [{
    id: 45, image: 'models/x.json',
    instance: { id: 46, textures: ['util/white'], usertextures: [{ name: '$mediaThumbnail', type: 'system' }] },
  }] }));
  const o = d.objects[0] as any;
  expect(o.instance).toEqual({ textures: ['util/white'], usertextures: [{ name: '$mediaThumbnail', type: 'system' }] });
  const bad = parseSceneJson(JSON.stringify({ objects: [{ id: 1, image: 'm.json', instance: 'nope' }] }));
  expect((bad.objects[0] as any).instance).toBeUndefined();
});
```

`tests/scene-assets.test.ts` 追加（复用该文件既有 mock fetch 手法）：
```ts
it('resolveImageAssets：instance.usertextures 含 $mediaThumbnail ⇒ mediaThumbnail=true；否则 false', async () => {
  // mock：models/x.json → { material: 'materials/util/solidlayer_instance.json' }；
  // material → { passes: [{ textures: ['util/white'] }] }；纹理路由返回 TEXV0005 fixture（沿用该文件既有 fixture）
  // 断言：normal 对象 mediaThumbnail=false；带 $mediaThumbnail 的对象为 true，且 texture 仍按材质解析。
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/media-palette.test.ts tests/scene-json.test.ts tests/scene-assets.test.ts`
Expected: FAIL（模块/字段不存在）

- [ ] **Step 3: 实现**

`src/client/media-palette.ts`：
```ts
// 从封面位图提取 WE MediaThumbnailEvent 需要的主/次/三色与对比色（启发式近似，非 WE 原算法）。
import type { MediaPalette } from '../shared/media.js';

const SAMPLE = 32;
const NEUTRAL: MediaPalette = {
  primary: [0, 0, 0], secondary: [0, 0, 0], tertiary: [0, 0, 0], text: [1, 1, 1], highContrast: [1, 1, 1],
};
const luminance = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

export function paletteFromPixels(width: number, height: number, rgba: Uint8ClampedArray): MediaPalette {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  let total = 0;
  const count = Math.min(width * height, rgba.length >> 2);
  for (let i = 0; i < count; i++) {
    const a = rgba[i * 4 + 3]!;
    if (a < 32) continue;
    const r = rgba[i * 4]!, g = rgba[i * 4 + 1]!, b = rgba[i * 4 + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4); // 4-bit/通道直方图
    const box = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    box.n += 1; box.r += r; box.g += g; box.b += b; buckets.set(key, box);
    total += 1;
  }
  if (total === 0) return NEUTRAL;
  const colors = [...buckets.values()]
    .map((box) => ({ n: box.n, rgb: [box.r / box.n / 255, box.g / box.n / 255, box.b / box.n / 255] as [number, number, number] }))
    .sort((a, b) => b.n - a.n)
    .map((c) => c.rgb);
  const primary = colors[0]!;
  const secondary = colors[1] ?? colors[0]!;
  const tertiary = colors[2] ?? secondary;
  const contrast = (c: [number, number, number]) => Math.abs(luminance(c) - luminance(primary));
  const text = [secondary, tertiary, [0, 0, 0], [1, 1, 1]].reduce((best, c) => (contrast(c as [number, number, number]) > contrast(best) ? (c as [number, number, number]) : best), [1, 1, 1] as [number, number, number]);
  const highContrast: [number, number, number] = luminance(primary) > 0.5 ? [0, 0, 0] : [1, 1, 1];
  return { primary, secondary, tertiary, text, highContrast };
}

export async function paletteFromImage(source: ImageBitmap | HTMLImageElement): Promise<MediaPalette> {
  const w = 'width' in source ? source.width : SAMPLE;
  const h = 'height' in source ? source.height : SAMPLE;
  if (!w || !h) return NEUTRAL;
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE; canvas.height = SAMPLE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return NEUTRAL;
  ctx.drawImage(source as CanvasImageSource, 0, 0, SAMPLE, SAMPLE);
  const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  return paletteFromPixels(SAMPLE, SAMPLE, data);
}
```

`src/client/media-texture.ts`：
```ts
import * as THREE from 'three';

// 所有绑定 $mediaThumbnail 的对象共享同一张 THREE.Texture：封面到达/切歌时只替换 image 并 needsUpdate。
export function createMediaThumbnailTextureSource(): MediaThumbnailTextureSource {
  const white = new Uint8Array([255, 255, 255, 255]);
  const texture = new THREE.DataTexture(white, 1, 1, THREE.RGBAFormat);
  texture.needsUpdate = true;
  let has = false;
  return {
    texture,
    hasImage: () => has,
    setImage(image: ImageBitmap | null) {
      if (image) {
        texture.image = image;
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.needsUpdate = true;
        has = true;
      } else {
        texture.image = { data: white, width: 1, height: 1 };
        texture.needsUpdate = true;
        has = false;
      }
    },
    dispose() { texture.dispose(); },
  };
}
```

`src/client/scene-json.ts` 追加解析（image 分支）：
```ts
function parseInstance(raw: unknown): SceneImageObject['instance'] | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as { textures?: unknown; usertextures?: unknown };
  const textures = Array.isArray(o.textures) ? o.textures.filter((t): t is string => typeof t === 'string' && !!t) : undefined;
  const usertextures = Array.isArray(o.usertextures)
    ? o.usertextures
      .map((u) => (u && typeof u === 'object' ? { name: String((u as any).name ?? ''), type: String((u as any).type ?? '') } : null))
      .filter((u): u is { name: string; type: string } => !!u && !!u.name)
    : undefined;
  if (!textures && !usertextures) return undefined;
  return { ...(textures ? { textures } : {}), ...(usertextures ? { usertextures } : {}) };
}
// image 返回分支追加： instance: parseInstance(o.instance),
```

`src/client/scene-assets.ts`：`resolveImageAssets` 内 `const model = await modelResp.json();` 之后：
```ts
const mediaThumbnail = Array.isArray(obj.instance?.usertextures)
  && obj.instance!.usertextures!.some((u) => u.name === '$mediaThumbnail');
// instance.textures 覆盖材质纹理槽（名字相对 materials/）：与材质槽同名则无操作。
const instanceTex = obj.instance?.textures?.[0];
const texName2 = instanceTex && instanceTex.includes('/') ? instanceTex : texName;
```
返回对象追加 `mediaThumbnail`，所有早退分支补 `mediaThumbnail: false`（纹理解析前早退时若 model 里已能判定，保持 false 也可——本壁纸 model 正常）。
（同时把 `resolveTexPath(matRef, texName2)` 用于 URL。）

`src/client/three-renderer.ts`：
1) 装配期创建共享纹理源（在 image 资源循环 L614 之前）：
```ts
const mediaThumbnailSource = createMediaThumbnailTextureSource();
```
资源循环里（L620 附近）：
```ts
const { texture, puppetPath, mediaThumbnail } = await resolveImageAssets(id, obj);
backgroundTextures.set(obj.id, mediaThumbnail ? mediaThumbnailSource.texture : texture);
mediaThumbnailObjects.add(obj.id);
```
（`const mediaThumbnailObjects = new Set<number>();`；若对象需要封面纹理但尚未就绪，绑定共享白纹理，稍后 setImage 即自动刷新。）
2) teardown 释放：`mediaThumbnailSource?.dispose()`（用 render 局部变量，teardown 需访问 → 提升为模块级 `let currentMediaThumbnailSource: MediaThumbnailTextureSource | null = null;`，装配时赋值，teardown dispose 并置 null）。
3) 快照回调里拉封面（需把 Task 7 的 sink.thumbnail 分支替换为异步）：
```ts
let thumbnailSeq = 0;
const loadThumbnail = async (rev: number) => {
  const seq = ++thumbnailSeq;
  const resp = await fetch(`/wallpapers/now-playing/thumbnail?rev=${rev}`);
  if (!resp.ok) throw new Error('thumbnail ' + resp.status);
  const blob = await resp.blob();
  const bitmap = await createImageBitmap(blob);
  if (seq !== thumbnailSeq || currentMedia === null) { bitmap.close?.(); return; }
  const palette = await paletteFromImage(bitmap);
  if (seq !== thumbnailSeq) { bitmap.close?.(); return; }
  currentMediaThumbnailSource?.setImage(bitmap);
  sink.thumbnail({ hasThumbnail: true, rev, palette });
};
const sink: MediaDispatchSink = {
  // …playback/status/properties 同 Task 7…
  thumbnail: (t) => {
    if (!t.hasThumbnail) { currentMediaThumbnailSource?.setImage(null); host.mediaThumbnail({ hasThumbnail: false, primaryColor: [0,0,0], … }); return; }
    void loadThumbnail(t.rev).catch(() => {
      currentMediaThumbnailSource?.setImage(null);
      host.mediaThumbnail({ hasThumbnail: false, primaryColor: [0,0,0], … });
    });
  },
};
```
（`applyMediaSnapshot` 在 Task 7 只派发中性调色板；本 Task 把 sink.thumbnail 改为异步拉取后用自己的调色板再派发一次，或者在 renderer 内直接不调 `applyMediaSnapshot` 的 thumbnail 分支——实现口径：给 `applyMediaSnapshot` 增加可选 `fetchThumbnail` 回调，`sink.thumbnail` 只接收真实 payload。计划采用后者：把封面分支做成 renderer 自己的逻辑，`applyMediaSnapshot` 的 `sink.thumbnail` 保留为「rev 通知」，renderer 在收到后异步拉取并派发最终事件。）
4) e2e：`verify-media-layer.mjs` 增加判据 [2]（洋红封面像素 > 200），Task 7 的脚本里该段先写成不可达的 `if (process.env.COVER_CHECK) {…}`，本 Task 改为默认执行。

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/media-palette.test.ts tests/scene-json.test.ts tests/scene-assets.test.ts` → PASS
Run: `npm run build && npm run e2e:media` → 判据 [1]–[4] 全绿

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/client/scene-json.ts src/client/media-palette.ts src/client/media-texture.ts src/client/scene-assets.ts src/client/three-renderer.ts e2e/verify/verify-media-layer.mjs tests/media-palette.test.ts tests/scene-json.test.ts tests/scene-assets.test.ts
git commit -m "feat(media): 实例封面纹理与主色" -m "- instance.usertextures($mediaThumbnail) 绑定共享封面纹理；instance.textures 覆盖纹理槽" -m "- 封面位图启发式提取主/次/三色与对比色；e2e 洋红封面判据"
```

---

## Task 9: 时间线动画纯核心（解析 + 贝塞尔求值）+ scene.json 解析

**Files:**
- Modify: `src/shared/types.ts`（时间线动画数据类型 + `SceneObjectBase.animations`）
- Modify: `src/client/scene-timeline.ts`（填充解析/求值纯函数）
- Modify: `src/client/scene-json.ts`（每个可动画属性提取 animation 块）
- Test: `tests/scene-timeline.test.ts`（新建）

**Interfaces:**
- Produces：
```ts
// shared/types.ts
export interface TimelineKeyframeHandle { x: number; y: number; enabled: boolean }
export interface TimelineKeyframe { frame: number; value: number; front?: TimelineKeyframeHandle; back?: TimelineKeyframeHandle }
export interface TimelineAnimation {
  property: TimelineProperty;
  channels: TimelineKeyframe[][];   // alpha: [c0]；origin/scale/angles/color: [c0,c1,c2]
  fps: number; frameCount: number; duration: number;
  mode: 'single' | 'loop' | 'mirror';
  startPaused: boolean; relative: boolean; wrapLoop: boolean;
  name: string;                    // '' = 无自定义名
  parentKey: TimelineProperty | null;
  childrenKeys: TimelineProperty[];
}
// SceneObjectBase 追加： animations?: Partial<Record<TimelineProperty, TimelineAnimation>>;

// scene-timeline.ts
export function parseTimelineAnimation(property: TimelineProperty, raw: unknown): TimelineAnimation | null;
export function sampleTimelineChannel(channel: TimelineKeyframe[], frame: number): number;
export function sampleTimeline(anim: TimelineAnimation, frame: number): number[];
```

- [ ] **Step 1: 写失败测试**

`tests/scene-timeline.test.ts`：
```ts
import { describe, expect, it } from 'vitest';
import { parseTimelineAnimation, sampleTimeline, sampleTimelineChannel } from '../src/client/scene-timeline.js';

const kf = (frame: number, value: number, opts: Record<string, unknown> = {}) => ({
  frame, value, front: { enabled: false, x: 0, y: 0 }, back: { enabled: false, x: 0, y: 0 }, ...opts,
});
const anim = (channels: Record<string, unknown[]>, options: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  ...channels, options: { fps: 60, length: 60, mode: 'single', ...options }, ...extra,
});

describe('parseTimelineAnimation', () => {
  it('解析三通道/选项/relative/父子/名称', () => {
    const raw = anim({ c0: [kf(0, 0)], c1: [kf(0, -0.25), kf(30, 0)], c2: [kf(0, 0)] }, { mode: 'loop', startpaused: true, name: 'Title', parent: { key: 'origin' }, children: [{ key: 'alpha' }], wraploop: true }, { relative: true });
    const a = parseTimelineAnimation('scale', raw)!;
    expect(a).toMatchObject({ property: 'scale', fps: 60, frameCount: 60, duration: 1, mode: 'loop', startPaused: true, relative: true, wrapLoop: true, name: 'Title', parentKey: 'origin', childrenKeys: ['alpha'] });
    expect(a.channels).toHaveLength(3);
    expect(a.channels[1]![1]).toMatchObject({ frame: 30, value: 0 });
  });
  it('alpha 只有 c0；缺 options 用缺省；坏数据 ⇒ null', () => {
    expect(parseTimelineAnimation('alpha', { c0: [kf(0, 0.2)] })?.channels).toHaveLength(1);
    expect(parseTimelineAnimation('alpha', {})).toBeNull();
    expect(parseTimelineAnimation('alpha', { c0: [] })).toBeNull();
  });
});

describe('sampleTimelineChannel', () => {
  it('端点精确；线性段中点 = 两关键帧均值（handles 关闭）', () => {
    const ch = [kf(0, 0), kf(10, 100)];
    expect(sampleTimelineChannel(ch, 0)).toBe(0);
    expect(sampleTimelineChannel(ch, 10)).toBe(100);
    expect(sampleTimelineChannel(ch, 5)).toBeCloseTo(50, 1);
  });
  it('段前后按端点值钳制', () => {
    const ch = [kf(5, 7), kf(10, 9)];
    expect(sampleTimelineChannel(ch, 0)).toBe(7);
    expect(sampleTimelineChannel(ch, 99)).toBe(9);
  });
  it('曲线段（front/back enabled）单调落在两端值之间', () => {
    const ch = [kf(0, 0, { front: { enabled: true, x: 1, y: 0 } }), kf(10, 100, { back: { enabled: true, x: -1, y: 0 } })];
    const mid = sampleTimelineChannel(ch, 5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(100);
  });
});

describe('sampleTimeline', () => {
  it('多通道分别采样', () => {
    const a = parseTimelineAnimation('origin', anim({ c0: [kf(0, 1), kf(10, 2)], c1: [kf(0, 5), kf(10, 6)], c2: [kf(0, 0), kf(10, 0)] }))!;
    expect(sampleTimeline(a, 10)).toEqual([2, 6, 0]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/scene-timeline.test.ts`
Expected: FAIL（导出/类型不存在）

- [ ] **Step 3: 实现**

`src/shared/types.ts` 加时间线类型（见 Interfaces）与 `animations` 字段。
`src/client/scene-timeline.ts` 追加：
```ts
// 时间线动画解析与求值（纯函数）：scene.json 的 {animation:{c0,c1,c2,options,relative}} 块。
const HANDLE_KEYS = ['c0', 'c1', 'c2'] as const;
const PROPERTY_CHANNELS: Record<TimelineProperty, number> = { alpha: 1, origin: 3, scale: 3, angles: 3, color: 3 };

function parseHandle(raw: unknown): TimelineKeyframeHandle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const x = Number(o.x), y = Number(o.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x, y, enabled: o.enabled === true };
}

function parseKeyframes(raw: unknown): TimelineKeyframe[] | null {
  if (!Array.isArray(raw)) return null;
  const out: TimelineKeyframe[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const frame = Number(o.frame), value = Number(o.value);
    if (!Number.isFinite(frame) || !Number.isFinite(value)) return null;
    const k: TimelineKeyframe = { frame, value };
    const front = parseHandle(o.front); if (front) k.front = front;
    const back = parseHandle(o.back); if (back) k.back = back;
    out.push(k);
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a.frame - b.frame);
  return out;
}

export function parseTimelineAnimation(property: TimelineProperty, raw: unknown): TimelineAnimation | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const need = PROPERTY_CHANNELS[property];
  const channels: TimelineKeyframe[][] = [];
  for (let i = 0; i < need; i++) {
    const parsed = parseKeyframes(o[HANDLE_KEYS[i]!]);
    if (!parsed) { if (i === 0) return null; channels.push([]); continue; }
    channels.push(parsed);
  }
  const options = (o.options && typeof o.options === 'object' ? o.options : {}) as Record<string, unknown>;
  const fpsRaw = Number(options.fps);
  const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : 60;
  const lengthRaw = Number(options.length);
  const frameCount = Number.isFinite(lengthRaw) && lengthRaw > 0 ? Math.floor(lengthRaw) : 60;
  const modeRaw = String(options.mode ?? 'single');
  const mode: TimelineAnimation['mode'] = modeRaw === 'loop' || modeRaw === 'mirror' ? modeRaw : 'single';
  const name = typeof options.name === 'string' ? options.name : '';
  const parent = (options.parent && typeof options.parent === 'object') ? String((options.parent as any).key ?? '') : '';
  const children = Array.isArray(options.children)
    ? options.children.map((c) => (c && typeof c === 'object' ? String((c as any).key ?? '') : '')).filter(Boolean)
    : [];
  return {
    property, channels, fps, frameCount, duration: frameCount / fps, mode,
    startPaused: options.startpaused === true,
    relative: o.relative === true,
    wrapLoop: options.wraploop === true,
    name,
    parentKey: (parent || null) as TimelineProperty | null,
    childrenKeys: children as TimelineProperty[],
  };
}

function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

// WE 关键帧曲线近似：handle x∈[-1,1] 映射到段长、y∈[-1,1] 映射到值差；enabled=false ⇒ 线性。
export function sampleTimelineChannel(channel: TimelineKeyframe[], frame: number): number {
  if (channel.length === 0) return 0;
  if (channel.length === 1) return channel[0]!.value;
  if (frame <= channel[0]!.frame) return channel[0]!.value;
  const last = channel[channel.length - 1]!;
  if (frame >= last.frame) return last.value;
  let i = 0;
  while (i + 1 < channel.length && channel[i + 1]!.frame <= frame) i += 1;
  const a = channel[i]!, b = channel[i + 1]!;
  const span = b.frame - a.frame;
  if (span <= 0) return b.value;
  const tFrame = (frame - a.frame) / span;
  const bezierOn = !!a.front?.enabled || !!b.back?.enabled;
  if (!bezierOn) return a.value + (b.value - a.value) * tFrame;
  const hv = b.value - a.value;
  const c1x = a.frame + (a.front?.enabled ? a.front.x : 0) * span;
  const c1y = a.value + (a.front?.enabled ? a.front.y : 0) * hv;
  const c2x = b.frame + (b.back?.enabled ? b.back.x : 0) * span;
  const c2y = b.value + (b.back?.enabled ? b.back.y : 0) * hv;
  // 以 x(t)=frame 二分求解 t（x 单调即可；handle 越界时仍收敛到端点值）
  let lo = 0, hi = 1;
  for (let n = 0; n < 24; n++) {
    const mid = (lo + hi) / 2;
    const x = bezier(a.frame, c1x, c2x, b.frame, mid);
    if (x < frame) lo = mid; else hi = mid;
  }
  return bezier(a.value, c1y, c2y, b.value, (lo + hi) / 2);
}

export function sampleTimeline(anim: TimelineAnimation, frame: number): number[] {
  return anim.channels.map((ch) => (ch.length > 0 ? sampleTimelineChannel(ch, frame) : 0));
}
```
`src/client/scene-json.ts`：base 里追加动画解析：
```ts
const ANIMATABLE = ['alpha', 'origin', 'scale', 'angles', 'color'] as const;
function animationFields(o: Record<string, unknown>): { animations?: Partial<Record<TimelineProperty, TimelineAnimation>> } {
  const out: Partial<Record<TimelineProperty, TimelineAnimation>> = {};
  for (const property of ANIMATABLE) {
    const v = o[property];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const parsed = parseTimelineAnimation(property, (v as { animation?: unknown }).animation);
    if (parsed) out[property] = parsed;
  }
  return Object.keys(out).length > 0 ? { animations: out } : {};
}
// base = { … ...objectScriptsField(o), ...animationFields(o) }
```
（scene-json import `parseTimelineAnimation` 与类型；client→client 允许。）

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run tests/scene-timeline.test.ts tests/scene-json.test.ts` → PASS
Run: `npm test` → 全绿

- [ ] **Step 5: 提交**

```bash
git add src/shared/types.ts src/client/scene-timeline.ts src/client/scene-json.ts tests/scene-timeline.test.ts
git commit -m "feat(scene): 时间线动画解析与求值" -m "- scene.json animation 块（贝塞尔/single·loop·mirror/startpaused/relative/父子/name）解析" -m "- 纯函数采样：线性/曲线段、端点钳制；样本 = 本机 3 张含动画壁纸"
```

---

## Task 10: 时间线运行时 + player 世界变换更新 + renderer 集成

**Files:**
- Modify: `src/client/scene-timeline.ts`（`createTimelineRuntime`）
- Modify: `src/client/threejs-player.ts`（`objectId → backgroundId` 映射 + `updateBackgroundTransform`）
- Modify: `src/client/three-renderer.ts`（本地变换快照、runtime 装配、onFrame 顺序、teardown）
- Test: `tests/scene-timeline.test.ts`（追加 runtime 用例）
- Test: `tests/threejs-player.test.ts`（`updateBackgroundTransform`）

**Interfaces:**
- Produces：
```ts
// scene-timeline.ts
export interface TimelineRuntimeOptions {
  desc: SceneDescription;
  localTransforms: Map<number, { origin: [number, number, number]; scale: [number, number, number]; angles: [number, number, number] }>;
  worldTransforms: Map<number, { origin: [number, number, number]; scale: [number, number, number]; angles: [number, number, number] }>;
  applyLocal: (writes: Map<number, LayerWrite>) => void;
  readLocal: (objectId: number) => LayerWrite;
  applyWorld: (objectId: number, wt: { origin: [number, number, number]; scale: [number, number, number]; angles: [number, number, number] }) => void;
}
export interface TimelineRuntime extends TimelineAnimationSource {
  advance(dt: number): void;
  sampleAndWrite(): void;
  applyInitial(): void;
  syncWorld(): void;
  dispose(): void;
}
export function createTimelineRuntime(opts: TimelineRuntimeOptions): TimelineRuntime;

// threejs-player.ts
updateBackgroundTransform(objectId: number, wt: { origin: [number, number, number]; scale: [number, number, number]; angles: [number, number, number] }): boolean;
```

- [ ] **Step 1: 写失败测试**

`tests/scene-timeline.test.ts` 追加：
```ts
import { createTimelineRuntime } from '../src/client/scene-timeline.js';
import { parseSceneJson } from '../src/client/scene-json.js';

const runtimeOf = (json: string) => {
  const desc = parseSceneJson(json);
  const localTransforms = new Map(desc.objects.map((o) => [o.id, { origin: [...o.origin] as [number, number, number], scale: [...o.scale] as [number, number, number], angles: [...(o.angles ?? [0, 0, 0])] as [number, number, number] }]));
  const world = new Map(localTransforms);
  const writes: Array<Map<number, any>> = [];
  const worldWrites: Array<[number, any]> = [];
  const rt = createTimelineRuntime({
    desc, localTransforms, worldTransforms: world,
    applyLocal: (w) => writes.push(w), readLocal: () => ({}), applyWorld: (id, wt) => worldWrites.push([id, wt]),
  });
  return { rt, writes, worldWrites };
};

it('非 startpaused 自动播放：alpha 从 0 推进到 1；startpaused 停在 frame 0', () => {
  const auto = runtimeOf(JSON.stringify({ objects: [{ id: 1, image: 'm.json',
    alpha: { value: 0.3, animation: { c0: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], options: { fps: 10, length: 10 } } } }] }));
  auto.rt.applyInitial();
  expect(auto.writes.at(-1)?.get(1)?.alpha).toBeCloseTo(0, 3);
  auto.rt.advance(0.5); auto.rt.sampleAndWrite();
  expect(auto.writes.at(-1)?.get(1)?.alpha).toBeCloseTo(0.5, 2);

  const paused = runtimeOf(JSON.stringify({ objects: [{ id: 2, image: 'm.json',
    alpha: { value: 0.9, animation: { c0: [{ frame: 0, value: 0.2 }, { frame: 10, value: 1 }], options: { fps: 10, length: 10, startpaused: true } } } }] }));
  paused.rt.applyInitial();
  expect(paused.writes.at(-1)?.get(2)?.alpha).toBeCloseTo(0.2, 3);
  paused.rt.advance(1); paused.rt.sampleAndWrite();
  expect(paused.writes.at(-1)?.get(2)?.alpha).toBeCloseTo(0.2, 3); // 未 play 不推进
  paused.rt.getByProperty(2, 'alpha', '')!.play();
  paused.rt.advance(0.5); paused.rt.sampleAndWrite();
  expect(paused.writes.at(-1)?.get(2)?.alpha).toBeCloseTo(0.6, 2);
});

it('relative origin 叠加静态值；父动画推进时子动画跟随父帧', () => {
  const { rt, writes } = runtimeOf(JSON.stringify({ objects: [{ id: 3, image: 'm.json',
    origin: { value: '100 200 0', animation: { c0: [{ frame: 0, value: 0 }, { frame: 10, value: 10 }], c1: [{ frame: 0, value: 0 }, { frame: 10, value: 20 }], c2: [{ frame: 0, value: 0 }, { frame: 10, value: 0 }], options: { fps: 10, length: 10, name: 'Move', children: [{ key: 'alpha' }] }, relative: true } },
    alpha: { value: 1, animation: { c0: [{ frame: 0, value: 0 }, { frame: 10, value: 1 }], options: { fps: 10, length: 10, parent: { key: 'origin' } } } } }] }));
  rt.applyInitial();
  rt.getByName(3, 'Move')!.play();
  rt.advance(0.5); rt.sampleAndWrite();
  const last = writes.at(-1)!;
  expect(last.get(3)?.origin?.[0]).toBeCloseTo(105, 1);
  expect(last.get(3)?.alpha).toBeCloseTo(0.5, 2);
});

it('syncWorld：动画对象与后代重算世界变换（只对发生变化的子树 applyWorld）', () => {
  const { rt, worldWrites } = runtimeOf(JSON.stringify({ objects: [
    { id: 1, image: 'm.json', scale: { value: '0.25 0.25 1', animation: { c0: [{ frame: 0, value: -0.25 }, { frame: 10, value: 0 }], c1: [{ frame: 0, value: -0.25 }, { frame: 10, value: 0 }], c2: [{ frame: 0, value: 0 }, { frame: 10, value: 0 }], options: { fps: 10, length: 10 } }, relative: true } },
    { id: 2, image: 'm.json', parent: 1, origin: '10 20 0' },
  ] }));
  rt.applyInitial();
  rt.syncWorld();
  expect(worldWrites.map(([id]) => id).sort()).toEqual([1, 2]);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/scene-timeline.test.ts`
Expected: FAIL（`createTimelineRuntime` 不存在）

- [ ] **Step 3: 实现**

`src/client/scene-timeline.ts` 追加 runtime：
```ts
interface AnimState { frame: number; playing: boolean; rate: number; finished: boolean }

export function createTimelineRuntime(opts: TimelineRuntimeOptions): TimelineRuntime {
  const states = new Map<string, AnimState>();
  const byObject = new Map<number, Map<TimelineProperty, TimelineAnimation>>();
  const byName = new Map<string, { objectId: number; property: TimelineProperty; anim: TimelineAnimation }>();
  for (const obj of opts.desc.objects) {
    if (!obj.animations) continue;
    const map = new Map<TimelineProperty, TimelineAnimation>();
    for (const [prop, anim] of Object.entries(obj.animations) as Array<[TimelineProperty, TimelineAnimation]>) {
      map.set(prop, anim);
      states.set(`${obj.id}|${prop}`, { frame: 0, playing: !anim.startPaused, rate: 1, finished: false });
      if (anim.name) byName.set(`${obj.id}|${anim.name}`, { objectId: obj.id, property: prop, anim });
    }
    byObject.set(obj.id, map);
  }

  // 后代反向索引（syncWorld 用：父动画变化要重算子对象世界变换）。
  const children = new Map<number, number[]>();
  for (const node of opts.desc.objects) {
    if (node.parent === undefined) continue;
    const arr = children.get(node.parent) ?? [];
    arr.push(node.id);
    children.set(node.parent, arr);
  }

  const playbackOf = (objectId: number, property: TimelineProperty, anim: TimelineAnimation): AnimPlayback => {
    const state = states.get(`${objectId}|${property}`)!;
    return {
      play() { state.playing = true; state.finished = false; },
      pause() { state.playing = false; },
      stop() { state.playing = false; state.frame = 0; state.finished = false; },
      isPlaying() { return state.playing && !state.finished; },
      getFrame() { return state.frame; },
      setFrame(v) { state.frame = Math.max(0, Math.min(anim.frameCount, v)); },
      get frameCount() { return anim.frameCount; },
      get fps() { return anim.fps; },
      get duration() { return anim.duration; },
      get name() { return anim.name; },
      get rate() { return state.rate; },
      set rate(v) { state.rate = typeof v === 'number' && v > 0 ? v : 1; },
    };
  };

  const source: TimelineAnimationSource = {
    getByProperty(objectId, property, name) {
      const anim = byObject.get(objectId)?.get(property);
      if (!anim) return null;
      if (name && anim.name !== name) return null;
      return playbackOf(objectId, property, anim);
    },
    getByName(objectId, name) {
      const hit = byName.get(`${objectId}|${name}`);
      return hit ? playbackOf(objectId, hit.property, hit.anim) : null;
    },
  };

  const animatedIds = [...byObject.keys()];
  const affected = new Set<number>();
  const addSubtree = (id: number) => { if (affected.has(id)) return; affected.add(id); for (const c of children.get(id) ?? []) addSubtree(c); };
  const refreshAffected = () => { affected.clear(); for (const id of animatedIds) addSubtree(id); };

  const sampleWrites = (): Map<number, LayerWrite> => {
    const out = new Map<number, LayerWrite>();
    for (const objectId of animatedIds) {
      const anims = byObject.get(objectId)!;
      const base = opts.localTransforms.get(objectId)!;
      const patch: LayerWrite = {};
      for (const [prop, anim] of anims) {
        const state = states.get(`${objectId}|${prop}`)!;
        const values = sampleTimeline(anim, state.frame);
        if (prop === 'alpha') patch.alpha = Math.max(0, Math.min(1, values[0]!));
        else if (prop === 'origin' || prop === 'scale' || prop === 'angles') {
          const staticV = base[prop];
          const v = [0, 1, 2].map((i) => (anim.relative ? staticV[i]! + values[i]! : values[i]!)) as [number, number, number];
          patch[prop] = v;
        } else if (prop === 'color') {
          // color 动画值按 WE 0-1 归一化语义写入；>1 视为已是 0-255。
          const max = Math.max(...values);
          patch.color = values.map((v) => (max <= 1 ? v * 255 : v)).slice(0, 3) as [number, number, number];
        }
      }
      out.set(objectId, patch);
    }
    return out;
  };

  const syncWorld = () => {
    if (animatedIds.length === 0) return;
    refreshAffected();
    // 用本地值（含脚本本帧写入）重建节点表 → 世界变换；只对受动画影响的子树 applyWorld。
    const localOf = (id: number) => {
      const anims = byObject.get(id);
      const base = opts.localTransforms.get(id)!;
      const state = opts.readLocal(id);
      const origin = state.origin ?? base.origin;
      const scale = state.scale ?? base.scale;
      const angles = state.angles ?? base.angles;
      return { origin, scale, angles };
    };
    const nodes = opts.desc.objects.map((o) => ({ id: o.id, parent: o.parent, ...localOf(o.id) }));
    const world = resolveWorldTransforms(nodes);
    for (const id of affected) {
      const wt = world.get(id);
      if (wt) opts.applyWorld(id, wt);
    }
  };

  return {
    ...source,
    advance(dt: number) {
      const step = Math.min(Math.max(dt, 0.0001), 0.25);
      for (const id of animatedIds) {
        const anims = byObject.get(id)!;
        for (const [prop, anim] of anims) {
          const state = states.get(`${id}|${prop}`)!;
          if (!state.playing || state.finished) continue;
          // 父动画驱动：子动画帧 = 父帧 × (子帧数/父帧数)
          let frame = state.frame;
          if (anim.parentKey) {
            const parentAnim = anims.get(anim.parentKey);
            const parentState = parentAnim ? states.get(`${id}|${anim.parentKey}`) : null;
            if (parentAnim && parentState) {
              frame = (parentState.frame / parentAnim.frameCount) * anim.frameCount;
            }
          }
          if (!anim.parentKey) frame += step * anim.fps * state.rate;
          const last = anim.frameCount;
          if (anim.mode === 'single') {
            if (frame >= last) { frame = last; state.finished = true; state.playing = false; }
          } else if (anim.mode === 'loop') {
            if (last > 0) frame %= last;
          } else {
            const span = Math.max(1, last);
            const cycle = frame % (span * 2);
            frame = cycle <= span ? cycle : span * 2 - cycle;
          }
          state.frame = frame;
        }
      }
    },
    sampleAndWrite() { opts.applyLocal(sampleWrites()); },
    applyInitial() {
      for (const [key, state] of states) {
        const [idStr, prop] = key.split('|') as [string, TimelineProperty];
        const anim = byObject.get(Number(idStr))?.get(prop);
        if (!anim) continue;
        state.frame = 0;
        state.playing = !anim.startPaused;
      }
      this.sampleAndWrite();
      syncWorld();
    },
    syncWorld,
    dispose() { /* 纯数据，无资源 */ },
  };
}
```
（`AnimsPlayback` 的可选元数据字段在 Task 6 已加；`keep` `refreshAffected` 只算一次也可，保留每次重算以容忍 desc 变更。）
`src/client/threejs-player.ts`：
1) 字段：`private readonly objectToBackground = new Map<number, number>();`
2) `addBackground` 与 `addPuppet` 在 `displayObjects.set(...)` 旁：`this.objectToBackground.set(opts.objectId, id);`
3) 新方法（放在 `displayObject` 附近）：
```ts
// 时间线动画：按 scene 对象 id 更新背景图层的世界变换（非隔离对象；隔离对象合成 quad 暂不支持，返回 false）。
updateBackgroundTransform(objectId: number, wt: { origin: [number, number, number]; scale: [number, number, number]; angles: [number, number, number] }): boolean {
  if (this.isolated.has(objectId)) return false;
  const bgId = this.objectToBackground.get(objectId);
  if (bgId === undefined) return false;
  const entry = this.backgroundEntries.get(bgId);
  if (!entry) return false;
  entry.origin = [wt.origin[0], wt.origin[1], wt.origin[2]];
  entry.scale = [wt.scale[0], wt.scale[1], wt.scale[2]];
  entry.angles = [wt.angles[0], wt.angles[1], wt.angles[2]];
  const align = alignmentWorldOffset(entry.size, entry.scale, entry.angles, entry.alignment);
  entry.align = [align[0], align[1]];
  entry.mesh.scale.set(entry.scale[0], entry.scale[1], entry.scale[2]);
  entry.mesh.rotation.set(entry.angles[0], entry.angles[1], entry.angles[2]);
  entry.mesh.position.set(
    entry.origin[0] - entry.sceneW / 2 + align[0],
    entry.origin[1] - entry.sceneH / 2 + align[1],
    entry.origin[2],
  );
  entry.parallaxApplied = false; // 让 tickParallax 下一帧按新基准重写
  return true;
}
```
（`alignmentWorldOffset` 已在三js-player 中存在（addBackground 使用），确认导入位置后复用；`addPuppet` 无 alignment，传 `entry.alignment` undefined 时该函数返回 [0,0]。）
`src/client/three-renderer.ts`：
1) 世界变换覆写前保存本地值（`:582-591` 之前）：
```ts
// 时间线动画的基准是**本地**变换；下面的 resolveWorldTransforms 会把 obj.origin/scale/angles
// 覆写成世界值，必须先留一份本地快照。
const localTransforms = new Map(desc.objects.map((o) => [o.id, {
  origin: [...o.origin] as [number, number, number],
  scale: [...o.scale] as [number, number, number],
  angles: [...(o.angles ?? [0, 0, 0])] as [number, number, number],
}]));
```
2) 在 `collectScriptSources` 之后、`SceneScriptHost.create` 之前创建 runtime（依赖 desc/localTransforms/worldTransforms/current 播放器——但播放器在 L1016 才创建；因此创建点放在**player 创建 + host 创建之间**，即 `current = result` 之后、`SceneScriptHost.create` 之前）：
```ts
// 时间线动画运行时（无动画 ⇒ null，零开销）。applyLocal 写进脚本状态表（与脚本写入同一优先级通道：
// 时间线先写、脚本 tick 覆盖，符合 WE「脚本返回值优先于时间线」语义）。
let currentTimeline: TimelineRuntime | null = null;
const timelineRuntime = localTransforms.size > 0 && desc.objects.some((o) => o.animations)
  ? createTimelineRuntime({
    desc, localTransforms, worldTransforms,
    applyLocal: (writes) => currentScriptHost?.applyExternal(writes),
    readLocal: (objectId) => currentScriptHost?.read(objectId) ?? {},
    applyWorld: (objectId, wt) => { result.player.updateBackgroundTransform(objectId, wt); },
  })
  : null;
currentTimeline = timelineRuntime;
```
注意：runtime 需要在 `SceneScriptHost.create({ ..., timeline: timelineRuntime ?? undefined })` 之前存在；`applyLocal` 闭包引用的 `currentScriptHost` 在 host 创建后才非空，`applyInitial()` 必须在 host 创建后调用。
3) `SceneScriptHost.create` 参数追加 `timeline: timelineRuntime ?? undefined,`。
4) host 创建后、媒体初始派发之前：
```ts
currentTimeline?.applyInitial();
applyLayerState(currentScriptHost?.drainDirty() ?? new Map(), lookup); // 本地变换+媒体初始一起落地
```
5) `onFrame` 顺序调整（`:975-994`）：
```ts
const host = currentScriptHost;
const loaded = current;
if (!host || !loaded) return;
currentTimeline?.advance(dt);
currentTimeline?.sampleAndWrite();   // 时间线值先写（脚本尚未跑）
const dirty = host.tick(dt);         // 脚本 tick（脚本写入覆盖时间线）
if (dirty.size > 0) applyLayerState(dirty, lookup);
currentTimeline?.syncWorld();        // 脚本/时间线最终值 → 世界变换
```
6) teardown：`currentTimeline?.dispose(); currentTimeline = null;`（放 `currentScriptHost?.dispose()` 之前）。

- [ ] **Step 4: 运行确认通过 + 构建 + e2e**

Run: `npx vitest run tests/scene-timeline.test.ts tests/threejs-player.test.ts` → PASS
Run: `npm test` → 全绿
Run: `npm run build && npm run e2e:media` → 判据全绿（媒体层淡入/滑入可见；无白框）
Run: `node e2e/verify/verify-text-clock-layer.mjs --no-teeth`（若本机有素材）→ 既有文本路径无回归

- [ ] **Step 5: 提交**

```bash
git add src/client/scene-timeline.ts src/client/threejs-player.ts src/client/three-renderer.ts tests/scene-timeline.test.ts tests/threejs-player.test.ts
git commit -m "feat(scene): 时间线动画运行时" -m "- 自动播放/startpaused/loop·mirror/relative/父子联动；时间线先写、脚本覆盖、再同步世界变换" -m "- player.updateBackgroundTransform 支持父级缩放动画带动子树"
```

---

## Task 11: 回归对照 + 文档 + 最终验证

**Files:**
- Modify: `AGENT.md`（新增「媒体集成」小节进 §5；§7 已知边界更新）
- Modify: `TESTING.md`（真机验收小节）
- Modify: `README.md`（特性一句话）
- Create: `.agents/notes/implemented/feature/2026-10-30-media-integration.md`
- Modify: `e2e/verify/verify-media-layer.mjs`（加 `--regression` 模式）

- [ ] **Step 1: 回归 e2e**

在 `verify-media-layer.mjs` 增加 `--regression`：依次用同一 harness 渲染 `2832263418 / 3793620838 / 2597392171`（不 mock 媒体路由，走真实无会话），断言 `__ready===true`、`window.__logs` 无 `[exception]`/`[error]`、`__listObjects().length > 0`，截图存 `e2e/.out/media/regression-<id>.png`。运行：
Run: `node e2e/verify/verify-media-layer.mjs --regression`
Expected: 3 张全部 PASS（`2597392171` 的 Fog 现在会动，属预期；不比对像素，仅确认不报错、对象齐全）

- [ ] **Step 2: 写文档**

`AGENT.md` §5 末尾新增条目（编号顺延 §5.54，以实际最后编号为准）：
```md
54. **媒体集成（Windows SMTC，2026-10-30）**：`project.json` 无媒体开关——是否启用由**场景脚本**决定：
   任一对象脚本含 `mediaPlaybackChanged|mediaStatusChanged|mediaPropertiesChanged|mediaThumbnailChanged|MediaPlaybackEvent`
    或 `instance.usertextures` 含 `$mediaThumbnail` 才创建 1s 轮询（其余壁纸零开销）。
   - host `media-session.ts`：仅 win32；常驻 PowerShell watcher（`:118` 行常量脚本）700ms 采样 SMTC，
     **懒启动 / 空闲 20s 退出 / 退出退避重启 / 60s 内 3 次失败降级**；会话选择剔除自身 appId 与页面标题
    （Chromium 为壁纸音效 `<audio>` 注册的自会话）；封面字节只存内存、**不落盘、不记日志**。
   - 路由 `/wallpapers/now-playing`（快照）与 `/wallpapers/now-playing/thumbnail?rev=`（字节）。
   - client：`media-input.ts` 轮询 + `applyMediaSnapshot` diff；`scene-script-host/VM` 派发四类事件
    （`MediaPlaybackEvent` 常量 = WE 官方 0/1/2；`thisObject.getAnimation()` 接时间线播放器）；
    文本脚本 runtime 广播 `mediaPropertiesChanged`。
   - 时间线属性动画：`scene-timeline.ts` 解析 scene.json `animation` 块（贝塞尔近似/单次·循环·往返/
    startpaused/relative/父子/name）；时间线值先写 `LayerStateTable`，脚本 tick 覆盖，之后重算世界变换；
    本机仅 3 张壁纸含动画（`3797976859` / 克西高达 Fog / Leon 的 `general.bloomstrength` 不做）。
   - 已知边界：仅 Windows；不派发 `mediaTimelineChanged`（快照保留 position/duration）；无播放控制；
    色板为主色启发式（非 WE 原算法）；贝塞尔曲线为样本校准近似；隔离对象（对象级效果链）的合成 quad
    不参与动画世界变换；`general.*`/effects/material 的时间线动画不做。
```
`AGENT.md` §7 已知缺口里把「`{animation}` 的关键帧轨道播放未实现」改为「已实现（对象属性动画，见 §5.54）；**仍未实现**：general/effect/material 动画、`mediaTimelineChanged`」。
`TESTING.md` 增加「§2.17 媒体集成真机验收」：DSH 桌面 App 播放音乐（Spotify/网易云等 SMTC 兼容播放器）→ 切歌/暂停/暂停后恢复/停止/关闭面板开关各一遍；确认封面（含切歌更新）、歌名/歌手、边框主色、淡入滑入；日志无 title/artist；`~/.dsh-use-wallpaper` 无新增文件；关闭开关后媒体层隐藏且 `Get-Process powershell` 中无本插件 watcher（空闲 20s 内会退出）。
`README.md` 特性列表加一行：`媒体集成：在 Windows 上读取系统媒体会话，让壁纸的专辑封面/歌名/歌手/主色与播放状态实时联动（仅内存，不落盘）。`
`.agents/notes/implemented/feature/2026-10-30-media-integration.md` 按既有 note 模板写 Problem/Decision/Alternatives/Consequences（引用本 spec 与计划；记录「为什么不是 SSE / 每次 spawn / 客户端解码封面」等取舍与 errata）。

- [ ] **Step 3: 最终验证**

```bash
npm test
npm run typecheck:tests
npm run verify:arch
npm run build
npm run build:client
npm run e2e:media
node e2e/verify/verify-media-layer.mjs --regression
git status --short   # 只应有文档/计划/notes 改动
```
Expected：全部 0 退出；`dist/client.js` 已重建；无未跟踪的临时文件（`research/` 与 `e2e/.out/` 均 gitignore）。

- [ ] **Step 4: 提交**

```bash
git add AGENT.md TESTING.md README.md .agents/notes/implemented/feature/2026-10-30-media-integration.md e2e/verify/verify-media-layer.mjs
git commit -m "docs(media): 媒体集成文档与真机验收清单" -m "- AGENT.md §5.54 数据流/隐私/路由/选择规则/动画范围与已知边界；§7 缺口更新" -m "- TESTING.md 真机验收小节 + README 特性 + 决策笔记"
```

---

## Self-Review（计划 vs spec）

**1) Spec 覆盖检查**

| spec 章节 | 覆盖 Task |
|---|---|
| §3 共享类型 | 1（types/factory）、6（TimelineProperty）、9（动画类型） |
| §4.1 watcher 进程（常量脚本/懒启动/空闲/退避/UTF8） | 1（脚本/解析）、2（生命周期） |
| §4.2 行解析与缓存 | 1、2 |
| §4.3 会话选择（自会话/pageTitle/playing/artist/lastChanged） | 1（纯函数）、2（lastChanged 记录） |
| §4.4 路由 | 3 |
| §4.5 设置（host/client/面板/运行期） | 3（host schema/state）、7（client DEFAULTS/面板/下发） |
| §5 client 媒体总线（1s/diff/生命周期/退避/开关） | 4、7（编排与开关） |
| §6.1 prelude 事件类 | 6 |
| §6.2 事件抓取与派发 + 初始派发 | 6（dispatchMedia）、7（初始 STOPPED/status） |
| §6.3 每对象多脚本 | 5（解析/收集）、6（host 可见性映射） |
| §6.4 thisObject | 6 |
| §7 文本脚本媒体事件 | 7 |
| §8.1 时间线解析 | 9 |
| §8.2 求值与播放（模式/startPaused/relative/父子/优先级/dt 钳制） | 9（求值）、10（运行时/优先级） |
| §9.1 instance 解析 | 8 |
| §9.2 共享封面纹理源 | 8 |
| §9.3 主色提取 | 8 |
| §10 错误处理与降级表 | 2（disabled/unsupported/no-powershell/watcher-failed）、7（事件失败不打断）、8（封面解码失败） |
| §11 性能预算 | 1/2（懒启动+空闲）、4（1s 轮询）、9/10（动画仅存在时创建） |
| §12 测试策略 | 每个 Task 的单测 + Task 7/8/11 的 e2e + Task 11 真机清单 |
| §13 交付物 | Task 11 + 各 Task 提交 |
| §14 DoD | Task 7（白框/停止隐藏）、8（封面）、10（动画/回归）、11（全量验证） |

无 spec 需求缺 Task。

**2) 占位符扫描**：本计划无 TBD/TODO/「类似 Task N」；唯一带实现期判断的是 `MediaPropertiesPayload` 的归属（shared vs client）——已在 Task 7 明确「定义在 `src/shared/media.ts`」。
**3) 类型一致性**：`MediaPropertiesPayload` 定义在 `src/shared/media.ts`（Task 6/7 共用）；`MediaThumbnailPayload`（VM 用，颜色三元组）与 `MediaThumbnailEventPayload`（media-input 用，含 palette/rev）是两个不同层类型，renderer 负责转换；`TimelineAnimationSource.getByProperty/getByName` 在 Task 6 定义、Task 10 实现；`LayerWrite` 由 `layer-state.ts` 提供（`color` 字段一期只记录，Task 10 不依赖其渲染）。

## Execution Handoff

计划已写入 `docs/superpowers/plans/2026-10-30-media-integration.md`。两种执行方式：

1. **Subagent-Driven（推荐）**：每 Task 派一个 fresh subagent 实现，Lead 在 Task 间审查/跑验收，适合本计划 11 个任务与严格 TDD 节奏。
2. **Inline Execution**：本会话内按 executing-plans 批量执行，检查点处暂停审查。

另外可先做 **Task 1–3（host 链路）+ Task 5–7（事件层/白框修复）** 两批小步落地，再继续 Task 8–10（封面/动画）——白框修复最早可在 Task 7 验收。


