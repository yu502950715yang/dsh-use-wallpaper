import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as host from '../src/host/index.js';
import { DATA_DIR_ENV } from '../src/host/data-dir.js';

describe('host entry', () => {
  it('数据目录不指向真实 home（不依赖 setup 的临时目录前缀）', () => {
    const dataDir = process.env[DATA_DIR_ENV];
    expect(dataDir).toBeTruthy();
    // setup 自建时是 tmpdir 下的随机目录；CI/外部显式设置 env 时尊重原值 —— 都不能是真实 home。
    expect(dataDir).not.toBe(join(homedir(), '.dsh-use-wallpaper'));
  });
  it('exports an apply function', () => {
    expect(typeof host.apply).toBe('function');
  });
  it('apply 声明设置面板策略（1.0 起只走 0.1.7 SettingsForms，不再调 settings.register）', () => {
    const registeredNs: string[] = [];
    const configureCalls: unknown[] = [];
    // 旧路径的 register 仍在 fake 上：apply 也不得调用它（≤0.1.6 适配层已删，AGENT.md §7.34）
    const fakeSettings = {
      register: (ns: string) => {
        registeredNs.push(ns);
        return { get: () => ({}), watch: () => () => {} };
      },
      configure: (presentation: unknown, owner: unknown) => {
        configureCalls.push({ presentation, owner });
        return () => {};
      },
    };
    // apply 现同时挂载壁纸路由（inject webServer），fake 按服务名提供对应服务
    const ctx = {
      inject: (svc: string[], fn: (c: any) => void) => {
        const services: any = {};
        if (svc.includes('settings')) services.settings = fakeSettings;
        if (svc.includes('webServer')) services.webServer = { register: () => () => {} };
        return fn(services);
      },
      fiber: { marker: 'plugin-fiber' },
    };
    host.apply(ctx);
    expect(configureCalls).toHaveLength(1);
    expect(configureCalls[0]).toEqual({ presentation: { auto: false }, owner: { marker: 'plugin-fiber' } });
    expect(registeredNs).toEqual([]);
  });
});
