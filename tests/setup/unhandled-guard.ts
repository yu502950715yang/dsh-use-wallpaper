// 未处理异常的判据器（纯逻辑，无副作用）：vitest 2.1 的 json reporter 不上报未处理异常，
// 也不让进程非零退出 ⇒ 由 setup 入口把捕获到的异常转成测试失败，CI 门禁才看得见。

export interface UnhandledGuard {
  record: (error: unknown) => void;
  /** 有记录则抛错并清空；每个测试文件收尾时调用。 */
  assertEmpty: () => void;
}

export function createUnhandledGuard(): UnhandledGuard {
  const seen: unknown[] = [];
  return {
    record: (error) => void seen.push(error),
    assertEmpty: () => {
      const list = seen.splice(0, seen.length);
      if (list.length > 0) throw new Error(describeUnhandled(list));
    },
  };
}

export function describeUnhandled(list: unknown[]): string {
  const head = list
    .slice(0, 3)
    .map((e) => (e instanceof Error ? e.message : String(e)).split('\n')[0])
    .join(' | ');
  return `检测到 ${list.length} 个未处理异常（vitest 的 json 报告不含它们，故由此守卫兜底）：${head}`;
}

type EventTarget = { on: (event: string, listener: (arg: never) => void) => unknown };

const hooked = new WeakSet<object>();

/** 幂等注册 process 级钩子：同一 target 只注册一次（多测试文件共用一个 worker 时不会累积监听器）。 */
export function installUnhandledHooks(guard: UnhandledGuard, target: EventTarget = process): void {
  if (hooked.has(target)) return;
  hooked.add(target);
  target.on('unhandledRejection', ((e: unknown) => guard.record(e)) as (arg: never) => void);
  target.on('uncaughtException', ((e: unknown) => guard.record(e)) as (arg: never) => void);
}
