import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// CI 测试门禁 scripts/check-known-failures.mjs 的判据测试。
// 「只对新增失败判红」不能顺带放过「测试没跑起来」——2026-10-10 实测三类形状：
//   普通断言失败   : testResults[].status=failed, message='' , 有 failed 断言（基线可豁免）
//   收集期失败     : testResults[].status=failed, message 非空, assertionResults 为空
//   未处理异常守卫 : testResults[].status=failed, message 非空, 断言全 passed
// 后两类属于套件级错误，只能判红，不能被按断言名豁免。

const SCRIPT = fileURLToPath(new URL('../scripts/check-known-failures.mjs', import.meta.url));

function runGate(report: unknown): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'known-failures-'));
  const reportPath = join(dir, 'report.json');
  writeFileSync(reportPath, JSON.stringify(report));
  try {
    const out = execFileSync(process.execPath, [SCRIPT, reportPath], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const assertion = (title: string, status: 'passed' | 'failed') => ({
  ancestorTitles: ['describe'],
  title,
  status,
});

describe('check-known-failures 门禁', () => {
  it('全绿 → exit 0', () => {
    const r = runGate({
      numTotalTests: 1,
      numPassedTests: 1,
      testResults: [{ name: '/repo/tests/a.test.ts', status: 'passed', message: '', assertionResults: [assertion('ok', 'passed')] }],
    });
    expect(r.code).toBe(0);
  });

  it('基线之外的新增失败 → exit 1', () => {
    const r = runGate({
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [{ name: '/repo/tests/a.test.ts', status: 'failed', message: '', assertionResults: [assertion('boom', 'failed')] }],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('NEW FAIL');
  });

  it('收集期失败（message 非空、assertionResults 为空）→ exit 1', () => {
    const r = runGate({
      numTotalTests: 0,
      numFailedTests: 0,
      testResults: [{ name: '/repo/tests/dom/broken.test.ts', status: 'failed', message: 'probe collect', assertionResults: [] }],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('SUITE ERROR');
  });

  it('套件级错误（message 非空、断言全 passed，如 afterAll 守卫）→ exit 1', () => {
    const r = runGate({
      numTotalTests: 1,
      numPassedTests: 1,
      testResults: [
        {
          name: '/repo/tests/a.test.ts',
          status: 'failed',
          message: '检测到 1 个未处理异常：boom',
          assertionResults: [assertion('ok', 'passed')],
        },
      ],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('SUITE ERROR');
    expect(r.out).toContain('boom');
  });

  // vitest 2.1 的 json reporter 实测不输出 unhandledErrors，这里固定「若报告带了就必须判红」的契约。
  it('报告带 unhandledErrors → exit 1（向前兼容契约）', () => {
    const r = runGate({
      numTotalTests: 1,
      numPassedTests: 1,
      testResults: [{ name: '/repo/tests/a.test.ts', status: 'passed', message: '', assertionResults: [assertion('ok', 'passed')] }],
      unhandledErrors: [{ message: 'boom' }],
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain('UNHANDLED');
  });
});
