import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMediaSessionService, parseWatcherLine, selectSession, playbackOfStatus, WATCH_SCRIPT } from '../src/host/media-session.js';
import type { RawMediaSession } from '../src/host/media-session.js';

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

const frame = (sessions: Array<Partial<RawMediaSession>>) => ({
  at: 1,
  sessions: sessions.map((s) => ({
    appId: '', status: 'Playing', title: '', artist: '', album: '', contentType: '', positionMs: 0, durationMs: 0, art: null, ...s,
  })),
});

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
  it('仅因 ownAppId 被剔除（不依赖 pageTitle 同时命中）', () => {
    const r = selectSession(frame([{ appId: 'DeepSeek Harness.exe', title: '其他标题', artist: 'x' }]), base);
    expect(r).toEqual({ session: null, reason: 'no-session' });
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
  // PS 双引号串里单个反引号是转义符：必须写成两个反引号才是字面量。
  expect(WATCH_SCRIPT).toContain('IAsyncOperation``1');
  // 零会话时不得每 700ms 重复输出空帧：首帧必发（$initialized），之后仅签名变化才发。
  expect(WATCH_SCRIPT).toContain('$initialized = $false');
  expect(WATCH_SCRIPT).toContain('-not $initialized -or $signature -ne $last');
  // 输出签名必须含 status：暂停/恢复必须触发输出行。
  expect(WATCH_SCRIPT).toContain('$album|$contentType|$status');
  // 封面签名不含 status：暂停/恢复不重发同一封面（否则 rev 无谓 +1）。
  expect(WATCH_SCRIPT).toContain('$artSig = "$appId|$title|$artist|$album|$contentType"');
  expect(WATCH_SCRIPT).not.toContain('$lastArt[$appId] = $sig');
  expect(WATCH_SCRIPT).toContain('if ($lastArt[$appId] -ne $artSig)');
  expect(WATCH_SCRIPT.indexOf('$artSig = ')).toBeLessThan(
    WATCH_SCRIPT.indexOf('if ($lastArt[$appId] -ne $artSig)'),
  );
  // 只有成功取到封面字节才记 $lastArt（失败允许下一轮重试），且必须早于 catch。
  const artSigAt = WATCH_SCRIPT.indexOf('$lastArt[$appId] = $artSig');
  expect(artSigAt).toBeGreaterThan(WATCH_SCRIPT.indexOf('$artType = [string]$st.ContentType'));
  expect(artSigAt).toBeLessThan(WATCH_SCRIPT.indexOf('} catch'));
});

/** 假 PowerShell 进程：stdout 是 PassThrough，kill 记录调用，exit/error 用 EventEmitter 手动触发。 */
class FakeWatcher extends EventEmitter {
  readonly stdout = new PassThrough();
  killed = 0;
  kill() { this.killed += 1; }
  emitExit() { this.emit('exit', null); }
  emitStartError(err: unknown = new Error('spawn ENOENT')) { this.emit('error', err); }
}

function setupService() {
  const procs: FakeWatcher[] = [];
  const timers: Array<() => void> = [];
  const cleared: unknown[] = [];
  let now = 0;
  const svc = createMediaSessionService({
    platform: 'win32',
    ownAppId: 'DeepSeek Harness.exe',
    spawnImpl: () => { const p = new FakeWatcher(); procs.push(p); return p as any; },
    now: () => now,
    idleMs: 20_000,
    idleCheckMs: 5_000,
    setIntervalImpl: (fn: () => void) => { timers.push(fn); return timers.length - 1; },
    clearIntervalImpl: (h: unknown) => { cleared.push(h); },
    log: () => {},
  });
  return {
    svc,
    procs,
    timers,
    cleared,
    advance: (ms: number) => { now += ms; },
    tick: (ms: number) => { now += ms; timers.forEach((f) => f()); },
    feedAt: (i: number, line: object) => procs[i]!.stdout.write(JSON.stringify(line) + '\n'),
    feed: (line: object) => procs[0]!.stdout.write(JSON.stringify(line) + '\n'),
  };
}

describe('createMediaSessionService', () => {
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
    procs[0]!.emitExit();
    svc.request({ pageTitle: 'x', enabled: true });
    expect(procs).toHaveLength(2);
  });

  it('封面按会话缓存：同一会话后续不带 art 的状态变化行 ⇒ hasThumbnail 仍 true、rev 不变', () => {
    const { svc, feed } = setupService();
    svc.request({ pageTitle: 'x', enabled: true });
    feed({ v: 1, at: 1, sessions: [{ appId: 'a', status: 'Playing', title: 'T', artist: 'A', artB64: Buffer.from('ABC').toString('base64'), artType: 'image/jpeg' }] });
    const first = svc.request({ pageTitle: 'x', enabled: true });
    expect(first.hasThumbnail).toBe(true);
    expect(first.thumbnailRev).toBeGreaterThan(0);
    const rev = first.thumbnailRev;
    // 签名变化（Playing → Paused）行不带 art；封面必须仍命中同一会话。
    feed({ v: 1, at: 2, sessions: [{ appId: 'a', status: 'Paused', title: 'T', artist: 'A' }] });
    const second = svc.request({ pageTitle: 'x', enabled: true });
    expect(second).toMatchObject({ available: true, reason: 'ok', playback: 'paused', hasThumbnail: true, thumbnailRev: rev });
    expect(svc.thumbnail(rev)?.bytes.toString('utf8')).toBe('ABC');
  });

  it('封面单一数据源：其它会话反复换封面不得让选中会话的 thumbnail 失配', () => {
    const { svc, feed } = setupService();
    svc.request({ pageTitle: 'x', enabled: true });
    feed({ v: 1, at: 1, sessions: [
      { appId: 's', status: 'Playing', title: 'S', artist: 'A', artB64: b64('S1'), artType: 'image/png' },
      { appId: 't', status: 'Stopped', title: 'T', artist: 'B', artB64: b64('T0'), artType: 'image/png' },
    ] });
    const first = svc.request({ pageTitle: 'x', enabled: true });
    expect(first).toMatchObject({ available: true, hasThumbnail: true });
    const sRev = first.thumbnailRev;
    expect(svc.thumbnail(sRev)?.bytes.toString('utf8')).toBe('S1');
    // 另一（非选中）会话的签名反复变化并重发封面：旧实现的 rev→art 全局 LRU 会把 sRev 挤掉。
    for (let i = 0; i < 9; i += 1) {
      feed({ v: 1, at: 2 + i, sessions: [
        { appId: 's', status: 'Playing', title: 'S', artist: 'A' },
        { appId: 't', status: i % 2 === 0 ? 'Closed' : 'Stopped', title: 'T', artist: 'B', artB64: b64(`T${i}`), artType: 'image/png' },
      ] });
    }
    const after = svc.request({ pageTitle: 'x', enabled: true });
    expect(after).toMatchObject({ available: true, reason: 'ok', hasThumbnail: true, thumbnailRev: sRev });
    expect(svc.thumbnail(sRev)?.bytes.toString('utf8')).toBe('S1');
  });

  it('rev 全局单调：idle stop 后新封面 rev > 旧 rev，旧 rev 不可读', () => {
    const { svc, procs, tick, feedAt } = setupService();
    svc.request({ pageTitle: 'x', enabled: true });
    feedAt(0, { v: 1, at: 1, sessions: [{ appId: 'a', status: 'Playing', title: 'T', artist: 'A', artB64: b64('OLD'), artType: 'image/png' }] });
    const oldRev = svc.request({ pageTitle: 'x', enabled: true }).thumbnailRev;
    expect(oldRev).toBeGreaterThan(0);
    tick(20_001);
    expect(procs[0]!.killed).toBe(1);
    expect(svc.thumbnail(oldRev)).toBeNull();
    svc.request({ pageTitle: 'x', enabled: true });
    expect(procs).toHaveLength(2);
    feedAt(1, { v: 1, at: 2, sessions: [{ appId: 'a', status: 'Playing', title: 'T', artist: 'A', artB64: b64('NEW'), artType: 'image/png' }] });
    const next = svc.request({ pageTitle: 'x', enabled: true });
    expect(next.thumbnailRev).toBeGreaterThan(oldRev);
    expect(svc.thumbnail(next.thumbnailRev)?.bytes.toString('utf8')).toBe('NEW');
    expect(svc.thumbnail(oldRev)).toBeNull();
  });

  it('dispose 幂等：kill/clearInterval 各一次，后续 request 返回 disabled 不 spawn', () => {
    const { svc, procs, cleared } = setupService();
    svc.request({ pageTitle: 'x', enabled: true });
    expect(procs).toHaveLength(1);
    svc.dispose();
    svc.dispose();
    expect(procs[0]!.killed).toBe(1);
    expect(cleared).toHaveLength(1);
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ available: false, reason: 'disabled' });
    expect(procs).toHaveLength(1);
  });

  it('spawn 异步 error ⇒ 下一 request no-powershell（退避窗口内不重复 spawn）；首帧后清错误', () => {
    const { svc, procs, advance, feedAt, tick } = setupService();
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ reason: 'no-session' });
    expect(() => procs[0]!.emitStartError()).not.toThrow();
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ available: false, reason: 'no-powershell' });
    expect(procs).toHaveLength(1);
    // 退避窗口外允许重试。
    advance(5_001);
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ reason: 'no-session' });
    expect(procs).toHaveLength(2);
    // 收到首帧 ⇒ 清 lastStartError（否则 idle stop 后会误报 no-powershell）。
    feedAt(1, { v: 1, at: 2, sessions: [{ appId: 'a', status: 'Playing', title: 'T', artist: 'A' }] });
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ reason: 'ok' });
    tick(20_001);
    expect(procs[1]!.killed).toBe(1);
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ reason: 'no-session' });
    expect(procs).toHaveLength(3);
  });

  it('60s 内连续 3 次 spawn error ⇒ watcher-failed 降级；窗口过后重试', () => {
    const { svc, procs, advance } = setupService();
    svc.request({ pageTitle: 'x', enabled: true });
    procs[0]!.emitStartError();
    advance(6_000);
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ reason: 'no-session' });
    procs[1]!.emitStartError();
    advance(6_000);
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ reason: 'no-session' });
    procs[2]!.emitStartError();
    expect(svc.stats().degraded).toBe(true);
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ available: false, reason: 'watcher-failed' });
    expect(procs).toHaveLength(3);
    advance(60_001);
    expect(svc.request({ pageTitle: 'x', enabled: true })).toMatchObject({ reason: 'no-session' });
    expect(procs).toHaveLength(4);
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
    const noPs = createMediaSessionService({ platform: 'win32', spawnImpl: (() => { throw new Error('ENOENT'); }) as any, log: () => {} });
    expect(noPs.request({ pageTitle: 'x', enabled: true })).toMatchObject({ available: false, reason: 'no-powershell' });
  });
});
