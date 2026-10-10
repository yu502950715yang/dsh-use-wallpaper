import { describe, expect, it, vi, afterEach } from 'vitest';

// DSH client-hmr 的 `rebuilt` 重载会「重新执行 bundle + 以全新状态重挂载插件」（旧 fiber 被 drain，
// 见 @deepseek-ai/dsh-client-hmr README）。本插件的挂载/收尾必须能承受这件事。
//
// 回归来源（2026-10-10 真机）：插件既没有 ctx 收尾、mount 也不幂等 ⇒ 每次重载叠一层
// `.wp-background-layer`（真机实测 **9 层**）。两层 z-index 都是 0（styles.ts），DOM 序在后的
// （= 更老的实例）压在上面 ⇒ 点击只在新实例被压住的画布里生效，屏幕永远不变
// —— 用户「选了魔兽之门却一直显示三角洲」。

function layers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.wp-background-layer'));
}
function fillSrcs(): string[] {
  return layers().flatMap((l) => Array.from(l.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? ''));
}

// 本用例收集到的 ctx.effect 收尾函数（= Cordis fiber drain 时要跑的 disposer）。
let disposers: Array<() => void> = [];

/** 模拟一次「bundle 重新执行 + apply」：重置模块注册表（= HMR 换新模块实例），**不清 body**。 */
async function applyFresh(settingsValue: Record<string, unknown> = {}): Promise<any> {
  vi.resetModules();
  const mod = await import('../../src/client/index.js');
  const ctx = {
    // Cordis 的资源收尾写法：ctx.effect(() => 收尾函数)，注册时即调用 callback。
    effect: (fn: () => unknown) => {
      const out = fn();
      disposers.push(typeof out === 'function' ? (out as () => void) : () => {});
      return () => {};
    },
    remote: {
      settings: {
        describe: async () => ({ ok: true, value: { namespaces: [{ ns: 'wallpaper-engine', value: settingsValue }] } }),
        update: async () => ({}),
      },
    },
  };
  mod.apply(ctx);
  if (document.readyState === 'loading') document.dispatchEvent(new Event('DOMContentLoaded'));
  return (window as any).__wallpaperEngine;
}

afterEach(() => {
  disposers = [];
  document.body.innerHTML = '';
  delete (window as any).__wallpaperEngine;
  delete (window as any).__wpEngineTeardown;
});

describe('插件重挂载与收尾（HMR rebuilt）', () => {
  it('重挂载后只剩一层，且留下的是新实例那层', async () => {
    const first = await applyFresh();
    first.show({ kind: 'image', url: '/old.jpg' });
    expect(layers()).toHaveLength(1);

    const second = await applyFresh(); // = rebuilt 后重新执行 bundle 再挂载
    second.show({ kind: 'image', url: '/new.jpg' });

    expect(layers()).toHaveLength(1);
    expect(fillSrcs()).toEqual(['/new.jpg']);
  });

  it('mount 清掉无主的残留层（老版本没有 teardown 时的兜底）', async () => {
    for (let i = 0; i < 3; i++) {
      const stale = document.createElement('div');
      stale.className = 'wp-background-layer';
      stale.appendChild(document.createElement('canvas'));
      document.body.prepend(stale);
    }
    expect(layers()).toHaveLength(3);

    await applyFresh();

    expect(layers()).toHaveLength(1);
    expect(document.querySelectorAll('.wp-background-layer canvas')).toHaveLength(0);
  });

  it('ctx dispose（drain 旧 fiber）→ 摘层并回默认背景', async () => {
    const api = await applyFresh();
    api.show({ kind: 'image', url: '/a.jpg' });
    expect(layers()).toHaveLength(1);
    expect(document.body.getAttribute('data-we-wallpaper')).toBe('true');

    for (const dispose of disposers) dispose();

    expect(layers()).toHaveLength(0);
    expect(document.body.hasAttribute('data-we-wallpaper')).toBe(false);
  });

  it('dispose 之后同实例再 mount 不复活', async () => {
    const api = await applyFresh();
    for (const dispose of disposers) dispose();

    api.mount();

    expect(layers()).toHaveLength(0);
  });
});
