import { describe, expect, it } from 'vitest';
import * as host from '../src/host/index.js';
import { DATA_DIR_ENV } from '../src/host/data-dir.js';

describe('host entry', () => {
  it('数据目录由全局 setup 注入到临时目录', () => {
    const dataDir = process.env[DATA_DIR_ENV];
    expect(dataDir).toBeTruthy();
    expect(dataDir).toContain('dsh-we-test-');
  });
  it('exports an apply function', () => {
    expect(typeof host.apply).toBe('function');
  });
  it('apply registers the settings namespace when settings is injected', () => {
    const dataDirBefore = process.env[DATA_DIR_ENV];
    expect(dataDirBefore).toBeTruthy();
    const registered: string[] = [];
    // register 返回 scope（get/watch）—— apply 用它做初始应用与热更新
    const fakeSettings = {
      register: (ns: string) => {
        registered.push(ns);
        return { get: () => ({}), watch: () => () => {} };
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
    };
    host.apply(ctx);
    // apply 后仍指向 setup 注入的临时目录，说明未回退真实 home
    expect(process.env[DATA_DIR_ENV]).toBe(dataDirBefore);
    expect(registered).toContain('wallpaper-engine');
  });
});
