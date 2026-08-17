import { describe, expect, it } from 'vitest';
import * as host from '../src/host/index.js';

describe('host entry', () => {
  it('exports an apply function', () => {
    expect(typeof host.apply).toBe('function');
  });
  it('apply registers the settings namespace when settings is injected', () => {
    const registered: string[] = [];
    const fakeSettings = { register: (ns: string) => registered.push(ns) };
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
    expect(registered).toContain('wallpaper-engine');
  });
});
