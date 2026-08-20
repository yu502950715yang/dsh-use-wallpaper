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

// scale 字段缺省/类型非法 → [1,1,1]（WE 语义：无缩放 = 原始尺寸）。
// 与 Rust 侧 scene.rs 的 unwrap_or([1.0,1.0,1.0]) 对齐——缺 scale 的 image 对象若按 [0,0,0]
// 解析，wasm 渲染器 image_half_ndc 会算出 quad 尺寸 0 → 主图不渲染（实测 3303428996 等 3 张壁纸）。
// 字符串部分 token（如 "2 2"）维持 vec3 的缺省 0 语义（与 Rust vec3_str 一致，z 不影响图片渲染）。
function scale3(s: unknown): [number, number, number] {
  if (typeof s !== 'string') return [1, 1, 1];
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
      scale: scale3(o.scale),
      size: size2(o.size),
      // Ruling 5：所有对象（kind 不限）的 effects 按 objects 顺序保留（全库 122 条中 105 条在 image 对象上）
      effects: Array.isArray(o.effects) ? o.effects : undefined,
    };
    if (typeof o.particle === 'string' && o.particle) {
      return { ...base, kind: 'particle' as const, particle: o.particle };
    }
    if (typeof o.image === 'string' && o.image) {
      // WE 内置合成层/全屏层/项目层（models/util/*.json）：pkg 内无此文件，
      // 对象是效果链容器/控制节点而非纹理 → 归类 util（渲染时跳过，effects 效果链渲染见二期）
      if (o.image.startsWith('models/util/')) {
        return {
          ...base, kind: 'util' as const, image: o.image,
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
