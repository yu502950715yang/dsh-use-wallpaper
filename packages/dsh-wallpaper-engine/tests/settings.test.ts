import { describe, expect, it } from 'vitest';
import { WALLPAPER_NS, WallpaperSettingsSchema } from '../src/host/settings.js';

describe('wallpaper settings schema', () => {
  it('applies defaults', () => {
    // schemastery 3.18 schema 为可调用形式：schema(input) 校验并返回默认值
    const value = WallpaperSettingsSchema({});
    expect(value).toMatchObject({
      selectedWallpaperId: '',
      overlayOpacity: 0.35,
      blurEnabled: false,
      blurRadius: 12,
      kenBurns: true,
    });
  });
  it('rejects opacity outside [0,1]', () => {
    expect(() => WallpaperSettingsSchema({ overlayOpacity: 2 })).toThrow();
  });
  it('exposes the wallpaper-engine namespace', () => {
    expect(WALLPAPER_NS).toBe('wallpaper-engine');
  });
});
