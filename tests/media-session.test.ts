import { describe, expect, it } from 'vitest';
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
  // 签名必须含 album / contentType，切专辑/类型也要触发重发。
  expect(WATCH_SCRIPT).toContain('$album|$contentType|$status');
  // 只有成功取到封面字节才记 $lastArt（失败允许下一轮重试）。
  expect(WATCH_SCRIPT.indexOf('$lastArt[$appId] = $sig')).toBeGreaterThan(
    WATCH_SCRIPT.indexOf('$artType = [string]$st.ContentType'),
  );
});

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
  return {
    svc,
    procs,
    timers,
    tick: (ms: number) => { now += ms; timers.forEach((f) => f()); },
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
    procs[0]!.exitCbs.forEach((cb) => cb());
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
