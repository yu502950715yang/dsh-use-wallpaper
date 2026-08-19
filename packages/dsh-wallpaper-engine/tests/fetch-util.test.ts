import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchWithRetry } from '../src/client/fetch-util.js';

afterEach(() => vi.unstubAllGlobals());

function okBody(bytes: number[]): Response {
  return new Response(new Uint8Array(bytes), { status: 200 });
}

describe('fetchWithRetry', () => {
  it('reject 1 次后重试成功，返回字节数组', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okBody([1, 2, 3]));
    vi.stubGlobal('fetch', fetchMock);
    const data = await fetchWithRetry('/wallpapers/scene/1/asset?name=x.json');
    expect(data).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('连续 reject 超过重试次数返回 null', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchWithRetry('/x', 2)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 次原始 + 2 次重试
  });
  it('404 确定性失败不重试，直接返回 null', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchWithRetry('/missing')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
