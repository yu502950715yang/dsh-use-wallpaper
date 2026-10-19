import { expect, it } from 'vitest';
import { loadJson, saveJson, loadStringSet, saveStringSet, STORAGE_KEYS } from '../src/client/local-store.js';

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}

it('损坏 JSON 回退 fallback，不抛', () => {
  const store = memoryStore();
  store.setItem(STORAGE_KEYS.recent, '{bad');
  expect(loadJson(STORAGE_KEYS.recent, {}, store)).toEqual({});
});

it('StringSet 往返并去重', () => {
  const store = memoryStore();
  saveStringSet(STORAGE_KEYS.favorites, ['1', '2', '2'], store);
  expect([...loadStringSet(STORAGE_KEYS.favorites, store)]).toEqual(['1', '2']);
});

it('无 localStorage 环境静默回退', () => {
  expect(loadJson('we:x', { a: 1 })).toEqual({ a: 1 });
  expect(() => saveJson('we:x', { a: 1 })).not.toThrow();
});
