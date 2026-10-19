import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  filterLibrary, loadLibraryState, markRecent, saveLibraryState, toggleFavorite, toggleHidden,
} from '../src/client/library-view.js';
import type { LibraryFilter, LibraryState } from '../src/client/library-view.js';
import { STORAGE_KEYS } from '../src/client/local-store.js';
import type { WallpaperInfo } from '../src/shared/types.js';

// 壁纸库纯函数：搜索 / 类型 / 收藏 / 隐藏 / 最近使用。状态落 localStorage（local-store 封装），
// node 环境用 vi.stubGlobal 提供内存实现，不另写存储访问。

const list: WallpaperInfo[] = [
  { id: '1', title: 'Snow', type: 'scene', hasPreviewGif: false, hasScene: true, previewUrl: '' },
  { id: '2', title: 'Rain', type: 'video', hasPreviewGif: false, hasScene: false, previewUrl: '' },
  { id: '3', title: 'Cloud', type: 'video', hasPreviewGif: false, hasScene: false, previewUrl: '' },
];

const state = (over: Partial<LibraryState> = {}): LibraryState => ({
  favorites: new Set<string>(), hidden: new Set<string>(), recent: {}, ...over,
});

const filter = (over: Partial<LibraryFilter> = {}): LibraryFilter => ({
  query: '', types: [], favoritesOnly: false, showHidden: false, sort: 'default', ...over,
});

const ids = (out: WallpaperInfo[]): string[] => out.map((w) => w.id);

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('filterLibrary', () => {
  it('按标题搜索（大小写不敏感）+ 类型筛选 + 隐藏过滤', () => {
    expect(ids(filterLibrary(list, filter({ query: 'ra' }), state()))).toEqual(['2']);
    expect(ids(filterLibrary(list, filter({ types: ['video'] }), state()))).toEqual(['2', '3']);
    expect(ids(filterLibrary(list, filter(), state({ hidden: new Set(['2']) })))).toEqual(['1', '3']);
  });

  it('收藏优先过滤 + 最近使用排序', () => {
    expect(ids(filterLibrary(list, filter({ favoritesOnly: true }), state({ favorites: new Set(['3']) })))).toEqual(['3']);
    expect(ids(filterLibrary(list, filter({ sort: 'recent' }), state({ recent: { '3': 2, '1': 1 } })))).toEqual(['3', '1', '2']);
  });

  it('showHidden 显示隐藏项；过滤顺序 hidden → favoritesOnly → types → query', () => {
    const s = state({ hidden: new Set(['2']), favorites: new Set(['2']) });
    // 隐藏优先于收藏：未开 showHidden 时，收藏也救不回来
    expect(ids(filterLibrary(list, filter({ favoritesOnly: true }), s))).toEqual([]);
    expect(ids(filterLibrary(list, filter({ favoritesOnly: true, showHidden: true }), s))).toEqual(['2']);
    // 类型与标题同时生效（AND）
    expect(ids(filterLibrary(list, filter({ types: ['video'], query: 'cl' }), state()))).toEqual(['3']);
  });

  it('default 保持入参顺序；title 按标题；recent 缺省为 0 排后且同分稳定', () => {
    expect(ids(filterLibrary(list, filter(), state()))).toEqual(['1', '2', '3']);
    expect(ids(filterLibrary(list, filter({ sort: 'title' }), state()))).toEqual(['3', '2', '1']);
    expect(ids(filterLibrary(list, filter({ sort: 'recent' }), state()))).toEqual(['1', '2', '3']);
    expect(ids(filterLibrary(list, filter({ sort: 'recent' }), state({ recent: { '2': 5 } })))).toEqual(['2', '1', '3']);
    // 同分保持入参顺序（1 与 3 都是时间戳 7）
    expect(ids(filterLibrary(list, filter({ sort: 'recent' }), state({ recent: { '1': 7, '3': 7 } })))).toEqual(['1', '3', '2']);
  });
});

describe('library state（localStorage 读写）', () => {
  it('loadLibraryState 读取收藏/隐藏/最近；recent 非普通对象（含存储的 null）回退 {}', () => {
    const store = memoryStore();
    store.setItem(STORAGE_KEYS.favorites, JSON.stringify(['1', '2', 3]));
    store.setItem(STORAGE_KEYS.hidden, JSON.stringify(['3']));
    store.setItem(STORAGE_KEYS.recent, JSON.stringify({ '1': 10 }));
    vi.stubGlobal('localStorage', store);

    const s = loadLibraryState();
    expect([...s.favorites]).toEqual(['1', '2']); // 非 string 已由 loadStringSet 过滤
    expect([...s.hidden]).toEqual(['3']);
    expect(s.recent).toEqual({ '1': 10 });

    // Task 1 已知边界：存储里是 'null' 时 loadJson 返回 null，不得让面板读 .has/索引时抛
    store.setItem(STORAGE_KEYS.recent, 'null');
    expect(loadLibraryState().recent).toEqual({});
    // 数组/标量同样不是「id → 时间戳」表
    store.setItem(STORAGE_KEYS.recent, '[1,2]');
    expect(loadLibraryState().recent).toEqual({});
    store.setItem(STORAGE_KEYS.recent, '42');
    expect(loadLibraryState().recent).toEqual({});
  });

  it('toggleFavorite/toggleHidden 反转并落盘，且不修改传入状态', () => {
    const store = memoryStore();
    vi.stubGlobal('localStorage', store);
    const before = state();

    const fav = toggleFavorite('1', before);
    expect(before.favorites.has('1')).toBe(false); // 旧状态不变：React 需新对象才重渲染
    expect([...fav.favorites]).toEqual(['1']);
    expect(JSON.parse(store.getItem(STORAGE_KEYS.favorites)!)).toEqual(['1']);
    expect([...toggleFavorite('1', fav).favorites]).toEqual([]); // 再点取消

    const hidden = toggleHidden('2', before);
    expect([...hidden.hidden]).toEqual(['2']);
    expect(JSON.parse(store.getItem(STORAGE_KEYS.hidden)!)).toEqual(['2']);
    expect([...toggleHidden('2', hidden).hidden]).toEqual([]);
  });

  it('markRecent 更新时间戳、去重、最多保留最近 200 条；空 id 不记录', () => {
    const store = memoryStore();
    vi.stubGlobal('localStorage', store);

    markRecent('a', 1);
    markRecent('a', 2);
    expect(JSON.parse(store.getItem(STORAGE_KEYS.recent)!)).toEqual({ a: 2 });

    for (let i = 0; i < 250; i++) markRecent(`w${i}`, 1000 + i);
    const recent = JSON.parse(store.getItem(STORAGE_KEYS.recent)!) as Record<string, number>;
    expect(Object.keys(recent)).toHaveLength(200);
    expect(recent.a).toBeUndefined(); // 最旧的被淘汰
    expect(recent.w50).toBe(1050); // 保留最新 200 条（w50..w249）
    expect(recent.w49).toBeUndefined();
    expect(recent.w249).toBe(1249);

    // 取消壁纸（空 id）不得占用「最近使用」
    markRecent('', 9999);
    expect(Object.keys(JSON.parse(store.getItem(STORAGE_KEYS.recent)!))).toHaveLength(200);
  });

  it('toggle 只写被改的键：不拿过期的 recent 覆盖 index.ts 刚写入的最近使用', () => {
    const store = memoryStore();
    vi.stubGlobal('localStorage', store);
    store.setItem(STORAGE_KEYS.recent, JSON.stringify({ '9': 1 }));
    // 面板状态是挂载时读的（recent 为空），期间选中壁纸已把 9 写进存储
    const stale = state();
    toggleFavorite('1', stale);
    expect(JSON.parse(store.getItem(STORAGE_KEYS.recent)!)).toEqual({ '9': 1 });
    toggleHidden('2', stale);
    expect(JSON.parse(store.getItem(STORAGE_KEYS.recent)!)).toEqual({ '9': 1 });
  });

  it('saveLibraryState 落盘三个键', () => {
    const store = memoryStore();
    vi.stubGlobal('localStorage', store);
    saveLibraryState(state({ favorites: new Set(['1']), hidden: new Set(['2']), recent: { '3': 7 } }));
    expect(JSON.parse(store.getItem(STORAGE_KEYS.favorites)!)).toEqual(['1']);
    expect(JSON.parse(store.getItem(STORAGE_KEYS.hidden)!)).toEqual(['2']);
    expect(JSON.parse(store.getItem(STORAGE_KEYS.recent)!)).toEqual({ '3': 7 });
  });
});
