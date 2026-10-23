// 对象级脚本入口（angles/origin/scale/color 的 {script, scriptproperties, value} 包装）。
// 回归：3765967112 的「Day/Night (Click)」脚本挂在 angles.script 上，此前只取静态 value、
// 源码被整段丢弃 ⇒ 精灵表自动播放（每秒变帧），桌面 WE 则静止。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSceneJson } from '../src/client/scene-json.js';

const DAY_NIGHT_SCRIPT = readFileSync(
  new URL('./fixtures/3765967112/day-night-script.js', import.meta.url),
  'utf8',
);

const sceneWith = (objects: unknown[]): string => JSON.stringify({
  camera: { center: '0 0 0', eye: '0 0 1', up: '0 1 0' },
  general: { orthogonalprojection: { width: 3840, height: 2160 } },
  objects,
});

describe('scene-json：对象级脚本入口', () => {
  it('angles.script 提取为 objectScript，保留 scriptproperties 与静态 angles', () => {
    const desc = parseSceneJson(sceneWith([{
      id: 123,
      name: 'Day/Night (Click)',
      image: 'models/workshop/3732231168/dayNightToggleSprite.json',
      parent: 71,
      origin: '0.00000 170.33264 0.00000',
      scale: '0.19827 0.20055 0.23690',
      size: '256.00000 256.00000',
      angles: {
        script: DAY_NIGHT_SCRIPT,
        scriptproperties: { dayStart: 0, nightStart: 12 },
        value: '0.00000 -0.00000 0.00000',
      },
    }]));
    const obj = desc.objects[0]!;
    expect(obj.objectScript).toContain('getTextureAnimation');
    expect(obj.objectScript).toBe(DAY_NIGHT_SCRIPT);
    expect(obj.objectScriptProperty).toBe('angles');
    expect(obj.objectScriptProperties).toEqual({ dayStart: 0, nightStart: 12 });
    // 静态 value 仍是当前可用的变换近似（解析行为零回归）
    expect(obj.origin).toEqual([0, 170.33264, 0]);
    expect((obj as { angles?: number[] }).angles).toEqual([0, -0, 0]);
  });

  it('优先级 angles > origin > scale > color；包装里的 {user,value} 保留绑定', () => {
    const desc = parseSceneJson(sceneWith([
      {
        id: 1, image: 'models/a.json',
        angles: { script: 'angles()', value: '0 0 0' },
        origin: { script: 'origin()', value: '1 2 3' },
        scale: { script: 'scale()', value: '1 1 1' },
        color: { script: 'color()', value: '1 1 1' },
      },
      { id: 2, image: 'models/b.json', origin: { script: 'origin()', value: '1 2 3' } },
      { id: 3, image: 'models/c.json', scale: { script: 'scale()', value: '1 1 1' } },
      {
        id: 4, image: 'models/d.json',
        color: { script: 'color()', scriptproperties: { tint: { user: 'u', value: 7 } }, value: '1 1 1' },
      },
      { id: 5, image: 'models/e.json', angles: '0 0 0' },
    ]));
    expect(desc.objects.map((o) => o.objectScript)).toEqual([
      'angles()', 'origin()', 'scale()', 'color()', undefined,
    ]);
    expect(desc.objects.map((o) => o.objectScriptProperty)).toEqual([
      'angles', 'origin', 'scale', 'color', undefined,
    ]);
    expect(desc.objects[3]!.objectScriptProperties).toEqual({ tint: { value: 7, user: { name: 'u' } } });
  });

  it('无转换字段脚本的普通对象不产出 objectScript（不误装载）', () => {
    const desc = parseSceneJson(sceneWith([
      { id: 6, image: 'models/f.json', origin: '0 0 0', scale: '1 1 1', angles: '0 0 0' },
    ]));
    expect(desc.objects[0]!.objectScript).toBeUndefined();
    expect(desc.objects[0]!.objectScriptProperty).toBeUndefined();
    expect(desc.objects[0]!.objectScriptProperties).toBeUndefined();
  });
});
