import { describe, expect, it } from 'vitest';
import { createUnhandledGuard, installUnhandledHooks } from './setup/unhandled-guard';

// vitest 2.1 的 json reporter 既不上报未处理异常，也不让进程非零退出（实测）⇒ 由守卫把它们
// 转成可判定的测试失败。这里固定守卫本身的行为，不触碰真实 process。
describe('unhandled guard', () => {
  it('没有异常时不抛错', () => {
    const guard = createUnhandledGuard();
    expect(() => guard.assertEmpty()).not.toThrow();
  });

  it('记录过异常时抛错，消息含数量与错误首行', () => {
    const guard = createUnhandledGuard();
    guard.record(new Error('probe rejected'));
    expect(() => guard.assertEmpty()).toThrow(/1 个未处理异常[\s\S]*probe rejected/);
  });

  it('assertEmpty 消费已记录项，重复调用不再抛错', () => {
    const guard = createUnhandledGuard();
    guard.record('boom');
    expect(() => guard.assertEmpty()).toThrow();
    expect(() => guard.assertEmpty()).not.toThrow();
  });

  it('installUnhandledHooks 对同一 target 只注册一次，并把事件转给 guard', () => {
    const registered: Record<string, (arg: unknown) => void> = {};
    const target = {
      on: (event: string, listener: (arg: unknown) => void) => {
        registered[event] = listener;
        return target;
      },
    };
    const guard = createUnhandledGuard();

    installUnhandledHooks(guard, target);
    installUnhandledHooks(guard, target);
    expect(Object.keys(registered).sort()).toEqual(['uncaughtException', 'unhandledRejection']);

    registered.unhandledRejection(new Error('from hook'));
    expect(() => guard.assertEmpty()).toThrow(/from hook/);
  });
});
