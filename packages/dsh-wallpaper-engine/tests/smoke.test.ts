import { describe, expect, it } from 'vitest';
import * as host from '../src/host/index.js';

describe('host entry', () => {
  it('exports an apply function', () => {
    expect(typeof host.apply).toBe('function');
  });
  it('apply registers the settings namespace when settings is injected', () => {
    const registered: string[] = [];
    const fakeSettings = { register: (ns: string) => registered.push(ns) };
    const ctx = { inject: (_svc: string[], fn: (c: any) => void) => fn({ settings: fakeSettings }) };
    host.apply(ctx);
    expect(registered).toContain('wallpaper-engine');
  });
});
