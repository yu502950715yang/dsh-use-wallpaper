import { describe, expect, it } from 'vitest';
import { createMediaOrchestration } from '../src/client/media-orchestration.js';
import type { MediaObjectLookup, MediaOrchestrationHost } from '../src/client/media-orchestration.js';
import { createMediaInput } from '../src/client/media-input.js';
import type { MediaInput, MediaInputOptions, MediaThumbnailEventPayload } from '../src/client/media-input.js';
import type { MediaThumbnailPayload } from '../src/client/scene-script-vm.js';
import { emptyMediaSnapshot, type MediaSessionSnapshot } from '../src/shared/media.js';

const snap = (patch: Partial<MediaSessionSnapshot>): MediaSessionSnapshot => ({
  ...emptyMediaSnapshot('ok', 1), ...patch,
});
const playing = snap({
  available: true, playback: 'playing', title: 'T', artist: 'A', album: 'B',
  contentType: 'music', hasThumbnail: true, thumbnailRev: 1,
});

/** 纯 fake：host/bindings/输入工厂全注入，不碰 three、网络、定时器。 */
function setup(
  initialEnabled = true,
  onThumbnail?: (payload: MediaThumbnailEventPayload) => MediaThumbnailPayload | null,
) {
  const log: string[] = [];
  const inputCalls: string[] = [];
  let enabled = initialEnabled;
  let snapshotCb: ((next: MediaSessionSnapshot, prev: MediaSessionSnapshot | null) => void) | null = null;
  let createCount = 0;
  const dirty = new Map<number, { visible: boolean }>([[7, { visible: false }]]);
  const lookup: MediaObjectLookup = () => undefined;
  const host: MediaOrchestrationHost = {
    mediaStatus: (e) => log.push('status:' + e),
    mediaPlayback: (s) => log.push('playback:' + s),
    mediaProperties: (p) => log.push('props:' + p.title),
    mediaThumbnail: (t) => log.push('thumb:' + t.hasThumbnail),
    applyExternal: () => {},
    drainDirty: () => new Map(dirty),
  };
  const input: MediaInput = {
    start: () => inputCalls.push('start'),
    stop: () => inputCalls.push('stop'),
    setPaused: (v) => inputCalls.push('paused:' + v),
    pollNow: async () => {},
    isRunning: () => false,
    dispose: () => inputCalls.push('dispose'),
  };
  const orch = createMediaOrchestration({
    host,
    bindings: [{ dispatchMediaProperties: (p) => log.push('binding:' + p.title) }],
    createInput: (opts: MediaInputOptions) => {
      createCount += 1;
      snapshotCb = opts.onSnapshot;
      return input;
    },
    applyDirty: (writes, target) => log.push(`dirty:${[...writes.keys()].join(',')}:${target === lookup}`),
    lookup,
    getEnabled: () => enabled,
    ...(onThumbnail ? { onThumbnail } : {}),
  });
  return {
    orch,
    log,
    inputCalls,
    lookup,
    fire: (next: MediaSessionSnapshot, prev: MediaSessionSnapshot | null = null) => snapshotCb!(next, prev),
    setEnabledFlag: (value: boolean) => { enabled = value; },
    get createCount() { return createCount; },
  };
}

describe('createMediaOrchestration', () => {
  it('start：先 status → playback(stopped) → 应用脏写入（同步、首帧前），enabled 才创建并启动 input', () => {
    const s = setup(true);
    s.orch.start();
    expect(s.log).toEqual(['status:true', 'playback:stopped', 'dirty:7:true']);
    expect(s.createCount).toBe(1);
    expect(s.inputCalls).toEqual(['start']);
  });

  it('enabled=false 时 start 只派发 status(false)+stopped+脏写入，不创建输入', () => {
    const s = setup(false);
    s.orch.start();
    expect(s.log).toEqual(['status:false', 'playback:stopped', 'dirty:7:true']);
    expect(s.createCount).toBe(0);
    expect(s.inputCalls).toEqual([]);
  });

  it('playing 快照：playback 与 properties 同时派发到 host 与 bindings，顺序 status→playback→props→thumb', () => {
    const s = setup(true);
    s.orch.start();
    s.log.length = 0;
    s.fire(playing, null);
    expect(s.log).toEqual(['status:true', 'playback:playing', 'props:T', 'binding:T', 'thumb:true']);
  });

  it('切歌：只重派 properties（不再派 status/playback/thumbnail）', () => {
    const s = setup(true);
    s.orch.start();
    s.fire(playing, null);
    s.log.length = 0;
    s.fire({ ...playing, title: 'T2' }, playing);
    expect(s.log).toEqual(['props:T2', 'binding:T2']);
  });

  // Task 8：封面要异步拉字节/解码/取色，renderer 返回 null 自行派发最终事件 ⇒ 编排不得先派中性色。
  it('onThumbnail 返回 null ⇒ 编排不派发 thumbnail（renderer 异步自行派发）', () => {
    const s = setup(true, () => null);
    s.orch.start();
    s.log.length = 0;
    s.fire(playing, null);
    expect(s.log).toEqual(['status:true', 'playback:playing', 'props:T', 'binding:T']);
  });

  it('setEnabled(false)→status(false)+stopped+input.stop；再 true→status(true)+input.start，首帧重放完整快照', () => {
    const s = setup(true);
    s.orch.start();
    s.log.length = 0;
    s.orch.setEnabled(false);
    expect(s.log).toEqual(['status:false', 'playback:stopped', 'dirty:7:true']);
    expect(s.inputCalls).toEqual(['start', 'stop']);

    s.log.length = 0;
    s.orch.setEnabled(true);
    expect(s.log).toEqual(['status:true']);
    expect(s.inputCalls).toEqual(['start', 'stop', 'start']);

    // stop() 清 prev ⇒ 重开后的首个快照按首帧语义重放（status/playback/properties/thumbnail 全量）。
    s.fire(playing, null);
    expect(s.log).toEqual([
      'status:true', 'status:true', 'playback:playing', 'props:T', 'binding:T', 'thumb:true',
    ]);
  });

  it('setPaused 转发给 input；恢复时补 start（且只在启用态启动）', () => {
    const s = setup(true);
    s.orch.start();
    s.orch.setPaused(true);
    s.orch.setPaused(false);
    expect(s.inputCalls).toEqual(['start', 'paused:true', 'paused:false', 'start']);

    s.orch.setPaused(true);
    s.setEnabledFlag(false); // 生产接线：renderer 先写开关变量再下发 setEnabled
    s.orch.setEnabled(false);
    s.inputCalls.length = 0;
    s.orch.setPaused(false);
    expect(s.inputCalls).toEqual(['paused:false']); // 禁用态恢复暂停不得偷偷重启轮询
  });

  it('dispose 幂等：释放输入后迟到的 onSnapshot 不再派发', () => {
    const s = setup(true);
    s.orch.start();
    s.log.length = 0;
    s.orch.dispose();
    s.orch.dispose();
    expect(s.inputCalls).toEqual(['start', 'dispose']);
    s.fire(playing, null);
    expect(s.log).toEqual([]);
  });

  it('host 派发抛错不崩：其余消费者继续收到事件，onError 收到异常', () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    const host: MediaOrchestrationHost = {
      mediaStatus: () => { throw new Error('status boom'); },
      mediaPlayback: () => log.push('playback'),
      mediaProperties: () => { throw new Error('props boom'); },
      mediaThumbnail: () => log.push('thumb'),
      applyExternal: () => {},
      drainDirty: () => new Map([[7, { visible: false }]]),
    };
    let snapshotCb: ((n: MediaSessionSnapshot, p: MediaSessionSnapshot | null) => void) | null = null;
    const orch = createMediaOrchestration({
      host,
      bindings: [{ dispatchMediaProperties: (p) => log.push('binding:' + p.title) }],
      createInput: (opts) => {
        snapshotCb = opts.onSnapshot;
        return {
          start: () => {}, stop: () => {}, setPaused: () => {},
          pollNow: async () => {}, isRunning: () => false, dispose: () => {},
        };
      },
      applyDirty: () => log.push('dirty'),
      lookup: () => undefined,
      getEnabled: () => true,
      onError: (e) => errors.push(e instanceof Error ? e.message : String(e)),
    });
    expect(() => orch.start()).not.toThrow();
    expect(log).toEqual(['playback', 'dirty']); // mediaStatus 抛错不阻断后续
    expect(errors).toEqual(['status boom']);

    log.length = 0;
    expect(() => snapshotCb!({ ...playing, title: 'T2', hasThumbnail: false }, playing)).not.toThrow();
    expect(log).toEqual(['binding:T2', 'thumb']); // properties 抛错不阻断 bindings/thumbnail
    expect(errors).toEqual(['status boom', 'props boom']);
  });

  // I1 端到端语义：真实 createMediaInput 接进来，关→开且快照不变时必须重放完整事件。
  it('集成：真实媒体输入在关→开后重放完整快照（prev 已清）', async () => {
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 6; i += 1) await Promise.resolve();
    };
    const log: string[] = [];
    const host: MediaOrchestrationHost = {
      mediaStatus: (e) => log.push('status:' + e),
      mediaPlayback: (s) => log.push('playback:' + s),
      mediaProperties: (p) => log.push('props:' + p.title),
      mediaThumbnail: (t) => log.push('thumb:' + t.hasThumbnail),
      applyExternal: () => {},
      drainDirty: () => new Map(),
    };
    const noTimers = { setIntervalImpl: () => 0, clearIntervalImpl: () => {} };
    const orch = createMediaOrchestration({
      host,
      bindings: [],
      createInput: (opts) => createMediaInput({
        ...opts,
        fetchImpl: async () => ({ ok: true, json: async () => playing }), // 永远是同一快照
        ...noTimers,
      }),
      applyDirty: () => {},
      lookup: () => undefined,
      getEnabled: () => true,
      inputOptions: { pageTitle: () => 'e2e' },
    });
    orch.start();
    await flush();
    log.length = 0;
    orch.setEnabled(false);
    orch.setEnabled(true);
    await flush();
    expect(log.filter((l) => l === 'playback:playing')).toHaveLength(1); // 关→开重放一次
    expect(log).toContain('status:true');
    expect(log).toContain('props:T');
    expect(log).toContain('thumb:true');
    orch.dispose();
  });
});
