// vitest 全局 setup：为每个测试文件注入独立临时数据目录（外部已设置则尊重原值），避免写入真实 home。
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR_ENV } from '../../src/host/data-dir.js';

const created = process.env[DATA_DIR_ENV] ? undefined : mkdtempSync(join(tmpdir(), 'dsh-we-test-'));
if (created) process.env[DATA_DIR_ENV] = created;

afterAll(() => {
  if (created) rmSync(created, { recursive: true, force: true });
});
