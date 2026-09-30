import { describe, expect, it } from 'vitest';
import { Config, WALLPAPER_NS, WallpaperSettingsSchema } from '../src/host/settings.js';

describe('wallpaper settings schema', () => {
  it('applies defaults', () => {
    // schemastery 3.18 schema 为可调用形式：schema(input) 校验并返回默认值
    const value = WallpaperSettingsSchema({});
    expect(value).toMatchObject({
      selectedWallpaperId: '',
      wallpaperDir: '',
      weAssetsDir: '',
      overlayOpacity: 0.35,
      blurEnabled: false,
      blurRadius: 12,
      kenBurns: true,
      glowEnabled: true,
      glowThreshold: 0.65,
      glowStrength: 0.35,
      // 文字可读性（2026-10-01）：默认 auto + 无描边 = 与加此功能前行为一致
      textColorMode: 'auto',
      textColor: '#ffffff',
      textOutline: 0,
    });
  });
  // 文字可读性字段：模式用宽松 string（未知值由 client 归一为 auto，避免新旧版本耦合），
  // 描边档位必须钳在 [0,3]（面板滑块范围），颜色由 client 做 hex 白名单校验。
  it('文字可读性字段的默认值与边界', () => {
    const v = WallpaperSettingsSchema({ textColorMode: 'white', textColor: '#123456', textOutline: 2 });
    expect(v).toMatchObject({ textColorMode: 'white', textColor: '#123456', textOutline: 2 });
    expect(() => WallpaperSettingsSchema({ textOutline: 4 })).toThrow();
    expect(() => WallpaperSettingsSchema({ textOutline: -1 })).toThrow();
    // 未知模式不在 schema 层拒绝（client 归一为 auto），避免旧版面板写入即失败
    expect(WallpaperSettingsSchema({ textColorMode: 'whatever' }).textColorMode).toBe('whatever');
  });
  it('rejects opacity outside [0,1]', () => {
    expect(() => WallpaperSettingsSchema({ overlayOpacity: 2 })).toThrow();
  });
  it('rejects glowThreshold outside [0, 0.99] and glowStrength outside [0, 4]', () => {
    expect(() => WallpaperSettingsSchema({ glowThreshold: 1 })).toThrow();
    expect(() => WallpaperSettingsSchema({ glowStrength: 5 })).toThrow();
  });
  it('exposes the wallpaper-engine namespace', () => {
    expect(WALLPAPER_NS).toBe('wallpaper-engine');
  });
  // DSH 0.1.7-alpha.1 起 settings 表单只投影 Config 里的 volatile 字段（volatileForm），
  // 无 volatile 的条目根本不出现在 describe() 里 ⇒ 必须在导出层标记 volatile。
  it('Config 是 volatile 的（0.1.7 表单据此投影字段）', () => {
    expect((Config as any).meta?.volatile).toBe(true);
  });
  // 旧路径（≤0.1.6 register）解析的是普通值；volatile schema 解析结果不是普通对象，
  // 拿它去旧版 register 会让 scope.get() 读不到字段 ⇒ 两个 schema 必须并存。
  it('WallpaperSettingsSchema 保持非 volatile（旧版 register 用）', () => {
    expect((WallpaperSettingsSchema as any).meta?.volatile).toBeFalsy();
  });
});
