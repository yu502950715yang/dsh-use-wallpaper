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
  it('falls back to a default camera when absent', () => {
    const desc = parseSceneJson('{"objects":[]}');
    expect(desc.camera.center).toEqual([0, 0, 0]);
  });
  it('throws on non-object input', () => {
    expect(() => parseSceneJson('[]')).toThrow();
  });
});
