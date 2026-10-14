import { describe, expect, it } from 'vitest';
import { parseSceneJson } from '../src/client/scene-json.js';

// 字段形态抄自本机真实 scene.json 副本（research/*-scene.json），此处内联以免依赖 gitignore 目录。
const scene = (extra: Record<string, unknown> = {}) => JSON.stringify({
  general: {
    cameraparallax: true, cameraparallaxamount: 0.5,
    cameraparallaxdelay: 0.1, cameraparallaxmouseinfluence: 1,
    orthogonalprojection: { width: 2400, height: 1555 },
  },
  objects: [{
    id: 12, name: 'bg', image: 'models/bg.json',
    origin: '1200.00000 777.50000 0.00000', size: '2400.00000 1555.00000',
    parallaxDepth: '1.00000 1.00000', ...extra,
  }],
});

describe('scene.json 视差字段', () => {
  it('读 general.cameraparallax* 与对象 parallaxDepth', () => {
    const d = parseSceneJson(scene());
    expect(d.parallax).toEqual({ enabled: true, amount: 0.5, delay: 0.1, mouseInfluence: 1 });
    const obj = d.objects[0];
    expect(obj.kind).toBe('image');
    expect(obj.kind === 'image' && obj.parallaxDepth).toEqual([1, 1]);
  });
  it('缺 parallaxDepth → undefined（不误开视差）', () => {
    const d = parseSceneJson(scene({ parallaxDepth: undefined }));
    expect(d.objects[0].kind === 'image' && d.objects[0].parallaxDepth).toBeUndefined();
  });
  it('缺 general 视差字段 → 全缺省', () => {
    const d = parseSceneJson(JSON.stringify({ objects: [] }));
    expect(d.parallax).toEqual({ enabled: false, amount: 0, delay: 0, mouseInfluence: 0 });
  });
  it('只有一轴非零也保留（另一轴 0 = 该轴不动）', () => {
    const d = parseSceneJson(scene({ parallaxDepth: '0.00000 2.00000' }));
    expect(d.objects[0].kind === 'image' && d.objects[0].parallaxDepth).toEqual([0, 2]);
  });
  it('畸形 parallaxDepth（空串 / 非字符串）→ undefined', () => {
    expect(parseSceneJson(scene({ parallaxDepth: '' })).objects[0]).toMatchObject({ kind: 'image' });
    expect((parseSceneJson(scene({ parallaxDepth: '' })).objects[0] as any).parallaxDepth).toBeUndefined();
    expect((parseSceneJson(scene({ parallaxDepth: 5 })).objects[0] as any).parallaxDepth).toBeUndefined();
  });
  it('particle 对象也产出 parallaxDepth', () => {
    // 真实库 227 处 parallaxDepth 中 106 处（47%）在 particle 对象上，是最大的一支。
    const d = parseSceneJson(JSON.stringify({ objects: [{ particle: 'particles/x.json', parallaxDepth: '1.00000 1.00000' }] }));
    const obj = d.objects[0];
    expect(obj.kind).toBe('particle');
    expect(obj.kind === 'particle' && obj.parallaxDepth).toEqual([1, 1]);
  });
  it('text 对象也产出 parallaxDepth', () => {
    const d = parseSceneJson(JSON.stringify({ objects: [{ text: 'x', parallaxDepth: '0.00000 2.00000' }] }));
    const obj = d.objects[0];
    expect(obj.kind).toBe('text');
    expect(obj.kind === 'text' && obj.parallaxDepth).toEqual([0, 2]);
  });
  it('畸形输入守护：多余 token 取前两轴 / 单轴非数值 / 全空白 → 判据', () => {
    const depth = (extra: Record<string, unknown>) => {
      const obj = parseSceneJson(scene(extra)).objects[0];
      return obj.kind === 'image' ? obj.parallaxDepth : undefined;
    };
    expect(depth({ parallaxDepth: '1 1 1' })).toEqual([1, 1]);
    expect(depth({ parallaxDepth: '1 abc' })).toBeUndefined();
    expect(depth({ parallaxDepth: '   ' })).toBeUndefined();
  });
});
