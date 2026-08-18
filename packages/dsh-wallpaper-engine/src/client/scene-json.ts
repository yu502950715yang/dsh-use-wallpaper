import type { SceneDescription, SceneObject } from '../shared/types.js';

function vec3(s: unknown): [number, number, number] {
  if (typeof s !== 'string') return [0, 0, 0];
  const parts = s.trim().split(/\s+/).map(Number);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

// WE 对象 size 字段（"宽 高"），缺失/非法时返回 undefined（由渲染器回退纹理宽高）
function size2(s: unknown): [number, number] | undefined {
  if (typeof s !== 'string') return undefined;
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length < 2 || !isFinite(parts[0]) || !isFinite(parts[1])) return undefined;
  return [parts[0], parts[1]];
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
      size: size2(o.size),
    };
    if (typeof o.particle === 'string' && o.particle) {
      return { ...base, kind: 'particle' as const, particle: o.particle };
    }
    if (typeof o.image === 'string' && o.image) {
      // WE 内置合成层/全屏层/项目层（models/util/*.json）：pkg 内无此文件，
      // 对象是效果链容器/控制节点而非纹理 → 归类 util（渲染时跳过，二期实现 effects）
      if (o.image.startsWith('models/util/')) {
        return {
          ...base, kind: 'util' as const, image: o.image,
          effects: Array.isArray(o.effects) ? o.effects : undefined,
        };
      }
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
