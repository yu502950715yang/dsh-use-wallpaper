// 系统音频「授权等待期」守卫（发布前 P1）：getDisplayMedia 授权弹窗是异步的，等待期间用户点
// 「停止」时采集尚未启动、stop 是空操作；授权返回后采集残留（面板显示未激活但仍在采集）。
// 用代号守卫：等待期 stop/新 start 会作废在途请求，完成后立即停采集并返回 'cancelled'。
import type { SystemAudioFailure } from './system-audio.js';

export interface AudioStartOps {
  start(): Promise<SystemAudioFailure | 'ok'>;
  stop(): void;
}

export interface AudioStartGuard {
  start(): Promise<SystemAudioFailure | 'ok'>;
  stop(): void;
}

export function createAudioStartGuard(ops: AudioStartOps): AudioStartGuard {
  let generation = 0;
  return {
    async start() {
      const gen = ++generation;
      const result = await ops.start();
      if (gen !== generation) {
        // 等待期已被 stop（或更新的 start 取代）：采集可能刚建立 ⇒ 立即停掉，不残留
        ops.stop();
        return 'cancelled';
      }
      return result;
    },
    stop() {
      generation += 1;
      ops.stop();
    },
  };
}
