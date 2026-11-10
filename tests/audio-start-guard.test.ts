import { describe, expect, it, vi } from 'vitest';
import { createAudioStartGuard } from '../src/client/audio-start-guard.js';

// P1（系统音频）：授权弹窗等待期间用户点「停止」→ 旧实现 stop 是空操作（采集尚未启动），
// 授权返回后采集残留（面板显示未激活但仍在采集）。修复 = 代号守卫：等待期请求 stop 后，
// start 完成时若代号已失效则立即停掉采集并返回 'cancelled'。
describe('createAudioStartGuard（授权等待期的停止）', () => {
  it('等待期 stop → 授权返回后立即停采集，返回 cancelled', async () => {
    let resolveStart!: (v: 'ok') => void;
    const start = vi.fn(() => new Promise<'ok'>((r) => { resolveStart = r; }));
    const stop = vi.fn();
    const guard = createAudioStartGuard({ start, stop });

    const pending = guard.start();
    guard.stop(); // 授权弹窗期间点停止
    resolveStart('ok'); // 授权随后成功（采集已启动）
    await expect(pending).resolves.toBe('cancelled');
    expect(stop).toHaveBeenCalledTimes(2); // 等待期 stop 一次 + start 完成兜底一次
  });

  it('无等待期停止 → start 结果原样返回', async () => {
    const start = vi.fn(async () => 'ok' as const);
    const stop = vi.fn();
    const guard = createAudioStartGuard({ start, stop });
    await expect(guard.start()).resolves.toBe('ok');
    expect(stop).not.toHaveBeenCalled();
  });

  it('start 失败原样返回（等待期无停止）', async () => {
    const guard = createAudioStartGuard({
      start: async () => 'unsupported' as const,
      stop: vi.fn(),
    });
    await expect(guard.start()).resolves.toBe('unsupported');
  });

  it('连续两次 start：旧的那次完成后作废并停采集（只保留最新一次）', async () => {
    const resolvers: Array<(v: 'ok') => void> = [];
    const stop = vi.fn();
    const guard = createAudioStartGuard({
      start: () => new Promise<'ok'>((r) => { resolvers.push(r); }),
      stop,
    });
    const first = guard.start();
    const second = guard.start();
    resolvers[0]('ok');
    resolvers[1]('ok');
    await expect(first).resolves.toBe('cancelled');
    await expect(second).resolves.toBe('ok');
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
