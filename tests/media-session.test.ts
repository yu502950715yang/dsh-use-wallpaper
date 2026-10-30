import { describe, expect, it } from 'vitest';
import { parseWatcherLine, selectSession, playbackOfStatus, WATCH_SCRIPT } from '../src/host/media-session.js';
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
});
