// @vitest-environment jsdom
// 开机动画播放期间抑制壁纸声音（2026-11-04 用户报：开机动画在播时壁纸声音也在放）。
// index.ts 用 bootActive 标志 + effective 声音开关把它下发给 scene 渲染器与背景层；
// 本用例 mock 掉渲染/背景/开机动画三个边界，只验「active 期间下发 false、结束后恢复用户设置」。
import { afterEach, describe, expect, it, vi } from 'vitest';

const boot = vi.hoisted(() => ({ opts: null as any }));
const layerSound = vi.hoisted(() => ({ setSoundEnabled: vi.fn() }));
const sceneSound = vi.hoisted(() => ({ setSoundEnabled: vi.fn() }));

vi.mock('../../src/client/boot-player.js', () => ({
  createBootPlayer: (opts: any) => {
    boot.opts = opts;
    return {
      start: () => Promise.resolve('ended'),
      play: () => Promise.resolve('ended'),
      getLast: () => null,
      dispose: () => {},
    };
  },
}));
vi.mock('../../src/client/background-layer.js', () => ({
  createBackgroundLayer: () => ({
    root: document.createElement('div'),
    setOverlayOpacity() {}, setBlur() {}, setPaused() {}, setSoundEnabled: layerSound.setSoundEnabled,
    setVolume() {}, setKenBurns() {}, setFitMode() {},
    showNone() {}, showImage() {}, showVideo: async () => 'ok', showWeb() {},
    getVideoHealth: () => null,
  }),
}));
vi.mock('../../src/client/wallpaper-controller.js', () => ({
  createWallpaperController: () => ({ load: async () => {}, select: async () => {}, applyTextStyle() {}, getList: () => [] }),
}));
vi.mock('../../src/client/styles.js', () => ({ injectWallpaperStyles: vi.fn() }));
vi.mock('../../src/client/three-renderer.js', () => ({
  createThreeSceneRenderer: () => ({
    getLastHealth: () => null,
    setOnHealth() {}, setPaused() {}, setQualityScale() {}, setGlow() {},
    setSoundEnabled: sceneSound.setSoundEnabled, setSoundVolume() {}, dispose() {},
  }),
}));

import { bootstrap } from '../../src/client/index.js';

afterEach(() => {
  (window as any).__wallpaperEngine?.teardown?.();
  delete (window as any).__wallpaperEngine;
  delete (window as any).__wallpaperEngineBoot;
  delete (window as any).__wpEngineTeardown;
  layerSound.setSoundEnabled.mockClear();
  sceneSound.setSoundEnabled.mockClear();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('开机动画期间抑制壁纸声音', () => {
  it('动画开始 → 壁纸声音下发 false；结束 → 恢复用户设置（默认 true）', async () => {
    bootstrap(undefined as any);
    await flush(); // 等 readClientSettings 的应用
    expect(boot.opts, 'bootstrap 应创建 bootPlayer 并传入 onActiveChange').toBeTruthy();
    expect(typeof boot.opts.onActiveChange).toBe('function');

    layerSound.setSoundEnabled.mockClear();
    sceneSound.setSoundEnabled.mockClear();

    boot.opts.onActiveChange(true);
    expect(layerSound.setSoundEnabled).toHaveBeenLastCalledWith(false);
    expect(sceneSound.setSoundEnabled).toHaveBeenLastCalledWith(false);

    boot.opts.onActiveChange(false);
    expect(layerSound.setSoundEnabled).toHaveBeenLastCalledWith(true);
    expect(sceneSound.setSoundEnabled).toHaveBeenLastCalledWith(true);
  });

  it('动画 active 期间异步应用设置也保持静音（effective 覆盖装配/下发路径）', async () => {
    bootstrap(undefined as any);
    boot.opts.onActiveChange(true); // 早于 readClientSettings 的异步应用
    await flush();
    expect(layerSound.setSoundEnabled).toHaveBeenLastCalledWith(false);
    expect(sceneSound.setSoundEnabled).toHaveBeenLastCalledWith(false);
  });
});
