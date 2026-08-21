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
  it('defaults missing/invalid scale to [1,1,1] (WE: no scale = original size)', () => {
    // 缺 scale 字段的 image 对象（实测 3303428996/3743126786/3760200530）：scale 缺省须为
    // [1,1,1] 而非 [0,0,0]——否则 wasm image_half_ndc quad 尺寸 0 → 主图不渲染。
    // 与 Rust 侧 scene.rs unwrap_or([1.0,1.0,1.0]) 语义对齐。
    const missing = parseSceneJson('{"objects":[{"id":1,"image":"a.json","origin":"0 0 0"}]}');
    expect((missing.objects[0] as any).scale).toEqual([1, 1, 1]);
    // 非法 scale（非字符串）同样回退 [1,1,1]
    const bad = parseSceneJson('{"objects":[{"id":1,"image":"a.json","scale":123}]}');
    expect((bad.objects[0] as any).scale).toEqual([1, 1, 1]);
    // 合法 scale 保持原值；origin 缺省仍为 [0,0,0]（不回归 camera/origin 语义）
    const ok = parseSceneJson('{"objects":[{"id":1,"image":"a.json","origin":"0 0 0","scale":"2 2 1"}]}');
    expect((ok.objects[0] as any).scale).toEqual([2, 2, 1]);
    expect((ok.objects[0] as any).origin).toEqual([0, 0, 0]);
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

// T3.1 text 对象归类（Ruling P3-1：particle > image > text(对象) > 空粒子兜底）。
// 真实样本：2937346640 的 VHS Time and Date（id=182）——text 字段为
// { script, scriptproperties, value } 对象，此前落入空粒子兜底不渲染。
describe('parseSceneJson text 对象归类（T3.1）', () => {
  const textObj = {
    id: 182, name: 'Time', origin: '1024 20 0', scale: '1 1 1',
    size: '400 100', color: '255 255 255 255', pointsize: '80',
    font: 'fonts/Atami-Regular.otf', alignment: 'center',
    text: { script: 'var d = new Date();', scriptproperties: '{}', value: '12:00' },
  };

  it('含 text 对象字段（无 image/particle）→ 归为 kind:text，text 取 text.value', () => {
    const desc = parseSceneJson(JSON.stringify({ objects: [textObj] }));
    const o = desc.objects[0] as any;
    expect(o.kind).toBe('text');
    expect(o.text).toBe('12:00');
  });

  it('保留 font/pointsize/color/size/alignment 字段', () => {
    const desc = parseSceneJson(JSON.stringify({ objects: [textObj] }));
    const o = desc.objects[0] as any;
    expect(o.font).toBe('fonts/Atami-Regular.otf');
    expect(o.pointsize).toBe(80);          // 字符串 "80" → 数值
    expect(o.color).toEqual([255, 255, 255]); // "r g b a" 取前 3 通道
    expect(o.size).toEqual([400, 100]);
    expect(o.alignment).toBe('center');
    expect(o.origin).toEqual([1024, 20, 0]);
    expect(o.scale).toEqual([1, 1, 1]);
  });

  it('text.value 缺失/非字符串 → text 为空字符串（静态渲染不崩）', () => {
    const desc = parseSceneJson(JSON.stringify({
      objects: [{ id: 1, text: { script: 'var d = new Date();' }, origin: '0 0 0', scale: '1 1 1' }],
    }));
    expect((desc.objects[0] as any).kind).toBe('text');
    expect((desc.objects[0] as any).text).toBe('');
  });

  it('Ruling P3-1 优先级：particle > image > text > 空粒子兜底', () => {
    // particle 字符串优先于 text
    const p = parseSceneJson(JSON.stringify({ objects: [{ id: 1, particle: 'particles/p.json', text: { value: 'x' } }] }));
    expect((p.objects[0] as any).kind).toBe('particle');
    // image 字符串优先于 text
    const img = parseSceneJson(JSON.stringify({ objects: [{ id: 2, image: 'models/a.json', text: { value: 'x' } }] }));
    expect((img.objects[0] as any).kind).toBe('image');
    // 仅 text → text
    const t = parseSceneJson(JSON.stringify({ objects: [{ id: 3, text: { value: 'x' } }] }));
    expect((t.objects[0] as any).kind).toBe('text');
    // 无引用无 text → 空粒子兜底（原行为不回归）
    const empty = parseSceneJson(JSON.stringify({ objects: [{ id: 4 }] }));
    expect((empty.objects[0] as any).kind).toBe('particle');
  });

  it('text 非对象（字符串/数组）不归为 text', () => {
    const s = parseSceneJson(JSON.stringify({ objects: [{ id: 1, text: 'fonts/a.otf' }] }));
    expect((s.objects[0] as any).kind).not.toBe('text');
    const arr = parseSceneJson(JSON.stringify({ objects: [{ id: 2, text: [] }] }));
    expect((arr.objects[0] as any).kind).not.toBe('text');
  });

  it('pointsize 非数字 / color 非法 → 对应字段 undefined', () => {
    const desc = parseSceneJson(JSON.stringify({
      objects: [{ id: 1, text: { value: 'x' }, pointsize: 'abc', color: 'zzz' }],
    }));
    expect((desc.objects[0] as any).pointsize).toBeUndefined();
    expect((desc.objects[0] as any).color).toBeUndefined();
  });
});
