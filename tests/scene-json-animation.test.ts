import { describe, expect, it } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';

const s = (animationlayers: unknown) => JSON.stringify({
  objects: [{ id: 16, name: 'mama', image: 'models/x.json', origin: '1280 720 0', size: '2560 1440', animationlayers }],
});

describe('animationlayers 解析（OWE ObjectParser.cpp 的字段与缺省）', () => {
  it('读 id/animation/rate/blend/visible，缺省 rate=1 blend=1 visible=false', () => {
    const d = parseSceneJson(s([{ id: 0, animation: 3 }]));
    const o = d.objects[0] as any;
    expect(o.animationLayers).toEqual([{ id: 0, animation: 3, rate: 1, blend: 1, visible: false }]);
  });
  it('无该字段 → undefined；空数组 → []', () => {
    expect((parseSceneJson(s(undefined)).objects[0] as any).animationLayers).toBeUndefined();
    expect((parseSceneJson(s([])).objects[0] as any).animationLayers).toEqual([]);
  });
  it('畸形条目被跳过，不产出半截对象', () => {
    const d = parseSceneJson(s([{ id: 'x' }, { id: 1, animation: 2, visible: true }]));
    expect((d.objects[0] as any).animationLayers).toEqual([{ id: 1, animation: 2, rate: 1, blend: 1, visible: true }]);
  });
});
