import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 测试数下限守卫（审查 P0-1）：门禁只判「红」时，删除测试文件/写错 include/把断言删成空转
// 都能让整库用例静默消失且三道门禁全绿。本脚本对 vitest json 报告校验：
//   testResults 非空、用例数 ≥ minTests、文件数 ≥ minTestFiles、跳过/待办 ≤ maxPendingTests。
// 下限存 scripts/test-floor.json；测试通过 TEST_FLOOR 环境变量注入自己的下限。

const SCRIPT = fileURLToPath(new URL('../scripts/check-test-floor.mjs', import.meta.url));

function runFloor(report: unknown, floor: Record<string, number>): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'test-floor-'));
  const reportPath = join(dir, 'report.json');
  const floorPath = join(dir, 'floor.json');
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(floorPath, JSON.stringify(floor));
  try {
    const out = execFileSync(process.execPath, [SCRIPT, reportPath], {
      encoding: 'utf8', stdio: 'pipe', env: { ...process.env, TEST_FLOOR: floorPath },
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FLOOR = { minTests: 10, minTestFiles: 2, maxPendingTests: 3 };
const testResult = (name: string) => ({ name, status: 'passed', message: '', assertionResults: [{ title: 't', status: 'passed' }] });

describe('check-test-floor 门禁（测试数下限）', () => {
  it('报告达标 → exit 0', () => {
    const r = runFloor({
      numTotalTests: 10, numPassedTests: 10,
      testResults: [testResult('/repo/tests/a.test.ts'), testResult('/repo/tests/b.test.ts')],
    }, FLOOR);
    expect(r.code).toBe(0);
  });

  it('报告没有任何测试文件（include 写错/收集崩溃/测试被删光）→ exit 1', () => {
    const r = runFloor({ numTotalTests: 0, numPassedTests: 0, testResults: [] }, FLOOR);
    expect(r.code).toBe(1);
    expect(r.out).toContain('没有任何测试文件');
  });

  it('用例数低于下限 → exit 1（删测试/删断言后报告变小）', () => {
    const r = runFloor({
      numTotalTests: 9, numPassedTests: 9,
      testResults: [testResult('/repo/tests/a.test.ts'), testResult('/repo/tests/b.test.ts')],
    }, FLOOR);
    expect(r.code).toBe(1);
    expect(r.out).toContain('< 下限');
  });

  it('测试文件数低于下限 → exit 1（整文件被删）', () => {
    const r = runFloor({
      numTotalTests: 12, numPassedTests: 12,
      testResults: [testResult('/repo/tests/a.test.ts')],
    }, FLOOR);
    expect(r.code).toBe(1);
    expect(r.out).toContain('测试文件数');
  });

  it('跳过/待办超过上限 → exit 1', () => {
    const r = runFloor({
      numTotalTests: 12, numPassedTests: 8, numPendingTests: 4,
      testResults: [testResult('/repo/tests/a.test.ts'), testResult('/repo/tests/b.test.ts')],
    }, FLOOR);
    expect(r.code).toBe(1);
    expect(r.out).toContain('跳过/待办');
  });

  it('报告文件缺失（vitest 崩溃/被中断且未清理旧报告）→ exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'test-floor-'));
    const floorPath = join(dir, 'floor.json');
    writeFileSync(floorPath, JSON.stringify(FLOOR));
    try {
      const out = execFileSync(process.execPath, [SCRIPT, join(dir, 'missing.json')], {
        encoding: 'utf8', stdio: 'pipe', env: { ...process.env, TEST_FLOOR: floorPath },
      });
      expect(out).toBe('');
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      expect(err.status).toBe(1);
      expect(String(err.stderr ?? '')).toContain('找不到测试报告');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
