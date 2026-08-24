import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseLibraryFoldersVdf,
  collectSteamRoots,
  collectWorkshopCandidates,
  collectAssetsCandidates,
  toCandidates,
  probeSteamPaths,
  readSteamInstallPathFromRegistry,
  type ProbeResult,
} from '../src/host/steam-paths.js';

// 自动探测：从 Steam 安装路径 / libraryfolders.vdf 库 / 常见根目录生成
// 壁纸目录（workshop/content/431960）与引擎目录（common/wallpaper_engine）候选。

describe('parseLibraryFoldersVdf', () => {
  it('提取所有库 path 并反转义双反斜杠', () => {
    const vdf = [
      '"libraryfolders"',
      '{',
      '\t"0"',
      '\t{',
      '\t\t"path"\t\t"C:\\\\Program Files (x86)\\\\Steam"',
      '\t}',
      '\t"1"',
      '\t{',
      '\t\t"path"\t\t"D:\\\\SteamLibrary"',
      '\t}',
      '}',
    ].join('\n');
    expect(parseLibraryFoldersVdf(vdf)).toEqual([
      'C:\\Program Files (x86)\\Steam',
      'D:\\SteamLibrary',
    ]);
  });
  it('无 path 条目返回空数组', () => {
    expect(parseLibraryFoldersVdf('"something" "else"')).toEqual([]);
  });
  it('空内容返回空数组', () => {
    expect(parseLibraryFoldersVdf('')).toEqual([]);
  });
});

describe('collectSteamRoots', () => {
  it('合并 steamPath、vdf 库与额外根并去重（Windows 大小写不敏感、分隔符无关）', () => {
    const vdf = '"libraryfolders"{"0"{"path""D:\\\\Steam"} "1"{"path""E:\\\\SteamLibrary"}}';
    const roots = collectSteamRoots({
      steamPath: 'D:\\Steam',
      vdfText: vdf,
      extraRoots: ['d:/steam', 'C:/Program Files (x86)/Steam'],
    });
    expect(roots).toEqual([
      join('D:', 'Steam'),
      join('E:', 'SteamLibrary'),
      join('C:', 'Program Files (x86)', 'Steam'),
    ]);
  });
  it('无任何输入时返回空数组', () => {
    expect(collectSteamRoots({})).toEqual([]);
  });
});

describe('collectWorkshopCandidates / collectAssetsCandidates', () => {
  it('从根目录生成 workshop 与 assets 候选路径', () => {
    expect(collectWorkshopCandidates(['D:\\Steam', 'E:\\SteamLibrary'])).toEqual([
      'D:\\Steam\\steamapps\\workshop\\content\\431960',
      'E:\\SteamLibrary\\steamapps\\workshop\\content\\431960',
    ]);
    expect(collectAssetsCandidates(['D:\\Steam'])).toEqual([
      'D:\\Steam\\steamapps\\common\\wallpaper_engine',
    ]);
  });
  it('空根列表返回空数组', () => {
    expect(collectWorkshopCandidates([])).toEqual([]);
    expect(collectAssetsCandidates([])).toEqual([]);
  });
});

describe('toCandidates', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wp-probe-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('标记存在性：存在的目录 exists=true，缺失的 exists=false', () => {
    const existing = join(dir, 'real');
    mkdirSync(existing, { recursive: true });
    const missing = join(dir, 'nope');
    const out = toCandidates([existing, missing], 'workshop');
    expect(out).toEqual([
      { path: existing, exists: true, kind: 'workshop' },
      { path: missing, exists: false, kind: 'workshop' },
    ]);
  });
});

describe('readSteamInstallPathFromRegistry', () => {
  it('从 reg query 输出解析 SteamPath 值', () => {
    const out = [
      '',
      'HKEY_CURRENT_USER\\Software\\Valve\\Steam',
      '    SteamPath    REG_SZ    D:\\Steam',
      '',
    ].join('\r\n');
    expect(readSteamInstallPathFromRegistry(() => ({ status: 0, stdout: out }))).toBe('D:\\Steam');
  });
  it('输出无 SteamPath 或命令失败时返回 undefined', () => {
    expect(readSteamInstallPathFromRegistry(() => ({ status: 0, stdout: 'nothing here' }))).toBeUndefined();
    expect(readSteamInstallPathFromRegistry(() => ({ status: 1, stdout: '' }))).toBeUndefined();
    expect(readSteamInstallPathFromRegistry(() => null)).toBeUndefined();
  });
});

describe('probeSteamPaths', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wp-probe2-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('组装探测结果：注册表路径 + vdf 库 + 额外根，标记存在性', () => {
    const workshop = join(dir, 'steam', 'steamapps', 'workshop', 'content', '431960');
    mkdirSync(workshop, { recursive: true });
    const result: ProbeResult = probeSteamPaths({
      registrySteamPath: join(dir, 'steam'),
      readVdf: () => '"libraryfolders"{"0"{"path""' + join(dir, 'steam').replace(/\\/g, '\\\\') + '"}}',
      extraRoots: [join(dir, 'steam')],
    });
    // workshop 候选：steam 根自身是 vdf 库，存在
    expect(result.workshop.some((c) => c.exists && c.path === workshop)).toBe(true);
    // assets 候选存在性按实际目录判定
    expect(result.assets.every((c) => c.exists === false)).toBe(true);
    // 首条 workshop 候选是注册表路径生成
    expect(result.workshop[0]!.path).toBe(join(dir, 'steam', 'steamapps', 'workshop', 'content', '431960'));
    // 存在性标记与路径一一对应
    for (const c of result.workshop) {
      expect(c.exists).toBe(c.path === workshop);
    }
  });

  it('无注册表与 vdf 时仅返回额外根候选（不存在的目录标记 exists=false）', () => {
    const fakeRoot = join(dir, 'fake-steam');
    const result = probeSteamPaths({ extraRoots: [fakeRoot] });
    expect(result.workshop).toEqual([
      { path: join(fakeRoot, 'steamapps', 'workshop', 'content', '431960'), exists: false, kind: 'workshop' },
    ]);
  });
});
