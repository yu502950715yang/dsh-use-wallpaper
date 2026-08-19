// src/client/fetch-util.ts
// 场景资源 fetch 的失败重试：仅对 fetch reject（连接复用竞态等瞬时失败）重试，
// 4xx/5xx 确定性失败不重试（避免掩盖资源缺失问题）。
export async function fetchWithRetry(url: string, retries = 2): Promise<Uint8Array | null> {
  for (let i = 0; ; i++) {
    try {
      const resp = await fetch(url);
      return resp.ok ? new Uint8Array(await resp.arrayBuffer()) : null;
    } catch {
      if (i >= retries) return null;
      await new Promise((r) => setTimeout(r, 50 * (i + 1))); // 指数退避 50ms/100ms
    }
  }
}
