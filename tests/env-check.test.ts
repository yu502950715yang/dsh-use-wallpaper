import { describe, expect, it, vi } from 'vitest';
import { checkEnvironment, detectWebGL2 } from '../src/client/env-check.js';

// 环境自检（1.0 可观测性）：只提示不修复；判定逻辑是纯函数，面板只消费结果。
describe('checkEnvironment', () => {
  it('三类问题都不满足时返回空数组', () => {
    expect(checkEnvironment({ hasWebGL2: true, weAssetsDir: 'D:/WE', currentKind: 'scene' })).toEqual([]);
  });

  it('WebGL2 不支持 → 提示回退预览图（warn）', () => {
    const issues = checkEnvironment({ hasWebGL2: false, weAssetsDir: 'D:/WE', currentKind: 'scene' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'webgl2', tone: 'warn' });
    expect(issues[0]!.text).toContain('WebGL2');
  });

  it('WebGL2 未知（null）不误报', () => {
    expect(checkEnvironment({ hasWebGL2: null, weAssetsDir: 'D:/WE', currentKind: null })).toEqual([]);
  });

  it('引擎目录未配置 → 提示粒子/特效退化（warn）', () => {
    const issues = checkEnvironment({ hasWebGL2: true, weAssetsDir: '', currentKind: null });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'we-assets', tone: 'warn' });
    expect(issues[0]!.text).toContain('Wallpaper Engine 安装目录');
  });

  it('当前壁纸是 web → 提示跨源无失败回退（info，只做静态说明）', () => {
    const issues = checkEnvironment({ hasWebGL2: true, weAssetsDir: 'D:/WE', currentKind: 'web' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ key: 'web-fallback', tone: 'info' });
    expect(issues[0]!.text).toContain('网页壁纸');
  });

  it('多个问题同时命中时按固定顺序全量返回', () => {
    const issues = checkEnvironment({ hasWebGL2: false, weAssetsDir: '', currentKind: 'web' });
    expect(issues.map((i) => i.key)).toEqual(['webgl2', 'we-assets', 'web-fallback']);
  });
});

describe('detectWebGL2', () => {
  it('无 DOM（node 环境）→ null（不判定）', () => {
    expect(detectWebGL2()).toBeNull();
  });

  it('getContext 返回对象 → true', () => {
    const originalDocument = globalThis.document;
    // @ts-expect-error 测试构造最小 document 桩
    globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
    try {
      expect(detectWebGL2()).toBe(true);
    } finally {
      if (originalDocument === undefined) delete (globalThis as any).document;
      else globalThis.document = originalDocument;
    }
  });

  it('getContext 返回 null → false', () => {
    const originalDocument = globalThis.document;
    // @ts-expect-error 测试构造最小 document 桩
    globalThis.document = { createElement: () => ({ getContext: () => null }) };
    try {
      expect(detectWebGL2()).toBe(false);
    } finally {
      if (originalDocument === undefined) delete (globalThis as any).document;
      else globalThis.document = originalDocument;
    }
  });

  it('getContext 抛错 → false（不穿出异常）', () => {
    const originalDocument = globalThis.document;
    // @ts-expect-error 测试构造最小 document 桩
    globalThis.document = { createElement: () => ({ getContext: () => { throw new Error('blocked'); } }) };
    try {
      expect(detectWebGL2()).toBe(false);
    } finally {
      if (originalDocument === undefined) delete (globalThis as any).document;
      else globalThis.document = originalDocument;
    }
  });
});
