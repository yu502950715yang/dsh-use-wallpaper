import { expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveDataDir, framesDirOf, DATA_DIR_ENV } from '../src/host/data-dir.js';

it('环境变量优先，默认 ~/.dsh-use-wallpaper', () => {
  expect(resolveDataDir({ env: { [DATA_DIR_ENV]: 'D:/tmp/we' }, home: 'C:/Users/x' })).toBe('D:/tmp/we');
  expect(resolveDataDir({ env: {}, home: 'C:/Users/x' })).toBe(join('C:/Users/x', '.dsh-use-wallpaper'));
  expect(framesDirOf('D:/tmp/we')).toBe(join('D:/tmp/we', 'frames'));
});
