import type { SceneDescription, SceneObject } from '../shared/types.js';

function vec3(s: unknown): [number, number, number] {
  if (typeof s !== 'string') return [0, 0, 0];
  const parts = s.trim().split(/\s+/).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

export function parseSceneJson(raw: string): SceneDescription {
  const root: any = JSON.parse(raw);
  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    throw new Error('scene.json root must be an object');
  }
  const cam = root.camera ?? {};
  const gen = root.general ?? {};
  const ortho = gen.orthogonalprojection ?? {};
  const objects: SceneObject[] = (Array.isArray(root.objects) ? root.objects : []).map((o: any) => {
    const base = {
      id: Number(o.id ?? 0),
      name: String(o.name ?? ''),
      origin: vec3(o.origin),
      scale: vec3(o.scale),
    };
    if (typeof o.particle === 'string' && o.particle) {
      return { ...base, kind: 'particle' as const, particle: o.particle };
    }
    if (typeof o.image === 'string' && o.image) {
      return { ...base, kind: 'image' as const, image: o.image };
    }
    return { ...base, kind: 'particle' as const, particle: '' }; // 无引用对象按空粒子处理（不渲染）
  });
  const cc = typeof gen.clearcolor === 'string' ? vec3(gen.clearcolor) : undefined;
  return {
    camera: {
      center: vec3(cam.center),
      eye: vec3(cam.eye),
      up: vec3(cam.up),
    },
    orthogonal: {
      width: Number(ortho.width ?? 1920),
      height: Number(ortho.height ?? 1080),
    },
    clearColor: cc,
    objects,
  };
}
