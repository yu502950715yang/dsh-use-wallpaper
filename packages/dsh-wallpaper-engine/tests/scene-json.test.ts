import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseSceneJson } from '../src/client/scene-json.js';

const raw = readFileSync(new URL('./fixtures/eva/scene.json', import.meta.url), 'utf8');

describe('parseSceneJson', () => {
  it('parses camera and orthogonal projection', () => {
    const desc = parseSceneJson(raw);
    expect(desc.camera.center).toEqual([35.931, -6.317, 0]);
    expect(desc.orthogonal).toEqual({ width: 2400, height: 1555 });
  });
  it('parses objects into image and particle kinds', () => {
    const desc = parseSceneJson(raw);
    const imageObj = desc.objects.find((o) => o.kind === 'image') as any;
    expect(imageObj.image).toBe('models/neon-genesis-evangelion-wallpaper-3.json');
    const particleObjs = desc.objects.filter((o) => o.kind === 'particle');
    expect(particleObjs.length).toBeGreaterThanOrEqual(4);
  });
  it('parses image object size field (WE pixels)', () => {
    const desc = parseSceneJson(raw);
    const imageObj = desc.objects.find((o) => o.kind === 'image') as any;
    expect(imageObj.size).toEqual([2400, 1555]);
    // 粒子对象无 size 字段
    const particleObj = desc.objects.find((o) => o.kind === 'particle') as any;
    expect(particleObj.size).toBeUndefined();
  });
  it('leaves size undefined when absent or invalid', () => {
    const desc = parseSceneJson('{"objects":[{"id":1,"image":"a.json","origin":"0 0 0","scale":"1 1 1"}]}');
    expect((desc.objects[0] as any).size).toBeUndefined();
    const bad = parseSceneJson('{"objects":[{"id":1,"image":"a.json","size":"abc","origin":"0 0 0","scale":"1 1 1"}]}');
    expect((bad.objects[0] as any).size).toBeUndefined();
  });
  it('falls back to a default camera when absent', () => {
    const desc = parseSceneJson('{"objects":[]}');
    expect(desc.camera.center).toEqual([0, 0, 0]);
  });
  it('classifies built-in util layers (models/util/*) as util kind', () => {
    // WE 内置合成层/全屏层/项目层：pkg 内无 models/util/*.json 文件，
    // 对象语义是效果链容器/控制节点（非纹理），必须与普通 image 区分开
    const desc = parseSceneJson(JSON.stringify({
      objects: [
        { id: 1, name: 'Compose', image: 'models/util/composelayer.json', origin: '0 0 0', scale: '1 1 1' },
        { id: 2, name: 'Global', image: 'models/util/fullscreenlayer.json', origin: '0 0 0', scale: '1 1 1' },
        { id: 3, name: 'Pic', image: 'models/girl_01.json', origin: '0 0 0', scale: '1 1 1' },
      ],
    }));
    const utilObjs = desc.objects.filter((o) => o.kind === 'util');
    expect(utilObjs.length).toBe(2);
    expect(utilObjs[0].image).toBe('models/util/composelayer.json');
    const pic = desc.objects.find((o) => o.kind === 'image') as any;
    expect(pic.image).toBe('models/girl_01.json');
  });
  it('preserves effects chain on util objects for future effect rendering', () => {
    const desc = parseSceneJson(JSON.stringify({
      objects: [{
        id: 1, name: 'girl_animation', image: 'models/util/composelayer.json',
        origin: '0 0 0', scale: '1 1 1',
        effects: [{ file: 'effects/waterwaves/effect.json', id: 244 }],
      }],
    }));
    const utilObj = desc.objects.find((o) => o.kind === 'util') as any;
    expect(utilObj.effects).toHaveLength(1);
    expect(utilObj.effects[0].file).toBe('effects/waterwaves/effect.json');
  });
  it('throws on non-object input', () => {
    expect(() => parseSceneJson('[]')).toThrow();
  });
});
