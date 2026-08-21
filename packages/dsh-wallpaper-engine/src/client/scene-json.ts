import type { SceneDescription, SceneObject } from '../shared/types.js';
import { parseScriptProperties } from './script-patterns.js';

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

// 可选数值字段（text 对象的 pointsize 等）：数字/数字字符串 → 有限数值；否则 undefined
function optNum(s: unknown): number | undefined {
  if (typeof s === 'number') return isFinite(s) ? s : undefined;
  if (typeof s !== 'string') return undefined;
  const n = Number(s.trim());
  return isFinite(n) ? n : undefined;
}

// 可选颜色字段（WE color 形如 "r g b a"，0-255）：取前 3 通道；非法 → undefined
function optColor(s: unknown): [number, number, number] | undefined {
  if (typeof s !== 'string') return undefined;
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || !isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2])) return undefined;
  return [parts[0], parts[1], parts[2]];
}

// 脚本字段提取（T3.3）：WE 对象脚本挂在 image 的 visible / text 的 text 对象上，
// 形如 { script, scriptproperties, value }。scriptproperties 直接读 scene.json 对象
// （{user,value} 包装由 parseScriptProperties 解包），不解析脚本源码。注意区分：
// visible 也可能是普通 {user,value} 开关包装（效果可见性等）→ script 为 undefined。
function scriptFields(o: { script?: unknown; scriptproperties?: unknown } | undefined): {
  script?: string;
  scriptProperties?: Record<string, unknown>;
} {
  const script = typeof o?.script === 'string' && o.script ? o.script : undefined;
  const scriptProperties = o?.scriptproperties !== undefined
    ? parseScriptProperties(o.scriptproperties)
    : undefined;
  return { script, scriptProperties };
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
      // T3.3：image 对象的可见性脚本 visible.{script,scriptproperties}（如 Simple Visualizer）
      // 一并解析——识别为 visualizer 时渲染器改走 64 条音频条路径（见 scene-renderer.ts）。
      const vis = typeof o.visible === 'object' && o.visible !== null && !Array.isArray(o.visible)
        ? o.visible as { script?: unknown; scriptproperties?: unknown }
        : undefined;
      return { ...base, kind: 'image' as const, image: o.image, ...scriptFields(vis) };
    }
    // Ruling P3-1（text 归类优先级）：o.text 为对象（非 null、非数组）→ kind:'text'。
    // 检查位置：image 检查之后、空粒子兜底之前；text.value 为缺省字符串（T3.3 起
    // text.script 识别为 clock 时动态生成，静态值仅作兜底）。此前这类对象落入
    // 空粒子兜底 → 不渲染（2937346640 的 VHS Time and Date id=182 即因此缺失）。
    if (typeof o.text === 'object' && o.text !== null && !Array.isArray(o.text)) {
      const t = o.text as { value?: unknown; script?: unknown; scriptproperties?: unknown };
      return {
        ...base,
        kind: 'text' as const,
        text: typeof t.value === 'string' ? t.value : '',
        font: typeof o.font === 'string' && o.font ? o.font : undefined,
        pointsize: optNum(o.pointsize),
        color: optColor(o.color),
        alignment: typeof o.alignment === 'string' && o.alignment ? o.alignment : undefined,
        // T3.3：text.script 识别为 clock 时每帧刷新时间文本（scriptproperties 已解包）
        ...scriptFields(t),
      };
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
