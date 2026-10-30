import { describe, expect, it } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';

const s = (objects: unknown[]) => JSON.stringify({ objects });
const SCRIPT = 'export function update(v){ return v; }';

describe('对象属性脚本（objectScripts）', () => {
  it('四个属性各挂脚本时全部收集，顺序 angles/origin/scale/color，保留 scriptproperties', () => {
    const d = parseSceneJson(s([{
      id: 7, name: 'x',
      angles: { script: SCRIPT + '//a', value: '0 0 0' },
      origin: { script: SCRIPT + '//o', scriptproperties: { speed: 2 }, value: '1 2 3' },
      scale: { script: SCRIPT + '//s', value: '1 1 1' },
      color: { script: SCRIPT + '//c', scriptproperties: { tint: { value: 7, user: { name: 'u' } } }, value: '1 1 1' },
    }]));
    const o = d.objects[0] as any;
    expect(o.objectScripts?.map((e: any) => e.property)).toEqual(['angles', 'origin', 'scale', 'color']);
    expect(o.objectScripts?.[1]?.scriptProperties).toEqual({ speed: 2 });
    expect(o.objectScripts?.[3]?.scriptProperties).toEqual({ tint: { value: 7, user: { name: 'u' } } });
  });
  it('无脚本的属性不产出条目；全无 ⇒ objectScripts undefined', () => {
    const d = parseSceneJson(s([
      { id: 1, image: 'models/x.json', angles: '0 0 0', origin: '1 2 3' },
      { id: 2, image: 'models/x.json', scale: { script: SCRIPT } },
    ]));
    expect((d.objects[0] as any).objectScripts).toBeUndefined();
    expect((d.objects[1] as any).objectScripts?.map((e: any) => e.property)).toEqual(['scale']);
  });

  it('alpha 脚本也收集（真实素材 3797976859 的淡入脚本挂在 alpha 上）', () => {
    const d = parseSceneJson(s([{
      id: 9, image: 'models/x.json',
      alpha: {
        script: "export function mediaThumbnailChanged(e){ thisObject.getAnimation().play(); }",
        value: 1,
        animation: { c0: [{ frame: 0, value: 0 }, { frame: 1, value: 1 }], options: { fps: 60, length: 60, startpaused: true } },
      },
    }]));
    const o = d.objects[0] as any;
    expect(o.objectScripts?.map((e: any) => e.property)).toEqual(['alpha']);
    expect(o.objectScripts[0].script).toContain('mediaThumbnailChanged');
    expect(o.animations.alpha).toMatchObject({ property: 'alpha', startPaused: true });
  });
});
