// src/client/visibility.ts —— WE 对象可见性绑定解析（T4.2）
// scene.json 的 visible 字段三种形态：
//   1. 布尔（visible: true/false）—— 静态开关；
//   2. { user: "propName", value } —— 用户属性绑定（WE 用户属性面板可切换的开关，
//      渲染时按注入的用户属性表查询，键缺失回退 value）；
//   3. { script: "…", value } —— 脚本绑定（rare；不执行任意脚本——可见性保持 value，
//      script 仅作为 T3.3 视觉脚本输入，见 scene-json.ts 的 image 分支）。
// 本模块为纯逻辑（node 可测）：parseVisible 归一化原始字段，resolveVisibility
// 注入用户属性求最终可见性。设置查询由调用方注入 getter（renderScene 不硬依赖
// 设置存储，见 scene-renderer.ts 的 RenderSceneOptions.getUserProperty）。
import type { VisibleBinding } from '../shared/types.js';
import { parseScriptProperties } from './script-patterns.js';

// 归一化 scene.json 的 visible 原始字段（任意 unknown）→ VisibleBinding。
// 规则：
//   布尔 → plain（原样保留）；
//   对象 → 含非空字符串 user → user 绑定（key 保留，value 取布尔或缺省 true）；
//          否则含非空字符串 script → script 绑定（script/scriptproperties 保留；
//          scriptproperties 的 {user,value} 包装由 parseScriptProperties 解包）；
//   缺失/畸形（null/数组/数字/字符串/空对象）→ undefined（无绑定 = 默认可见，
//   不误杀对象）。
// value 缺省 true：WE 场景中 value 总是携带（true/false），缺失仅见于畸形数据，
// 保守取可见（渲染侧不因字段缺失丢失对象）。
export function parseVisible(raw: unknown): VisibleBinding | undefined {
  if (typeof raw === 'boolean') return { kind: 'plain', value: raw };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as { user?: unknown; script?: unknown; scriptproperties?: unknown; value?: unknown };
  const value = typeof o.value === 'boolean' ? o.value : true;
  // user 优先于 script：同对象双键（畸形数据）时用户开关是更直接的控制
  if (typeof o.user === 'string' && o.user) {
    return { kind: 'user', key: o.user, value };
  }
  if (typeof o.script === 'string' && o.script) {
    return {
      kind: 'script',
      script: o.script,
      // 与 T3.3 scriptFields 行为一致：scriptproperties 缺失 → undefined（不产生空对象）
      scriptProperties: o.scriptproperties !== undefined ? parseScriptProperties(o.scriptproperties) : undefined,
      value,
    };
  }
  return undefined;
}

// 求对象最终可见性（纯函数，用户属性由调用方聚成 Record 注入）：
//   无绑定 → true（默认可见）；
//   plain → 原样；
//   user → userProps[key] 为布尔 → 用户值覆盖绑定 value；键缺失/值非布尔 → 回退 value
//     （WE 语义：用户未切换时按壁纸默认值；返回恒为布尔）；
//   script → 保持 value（脚本求值（含已知模式）超出本期范围，见任务 brief）。
export function resolveVisibility(
  obj: { visible?: VisibleBinding | undefined },
  userProps: Record<string, unknown>,
): boolean {
  const v = obj.visible;
  if (!v) return true;
  switch (v.kind) {
    case 'plain':
      return v.value;
    case 'user': {
      const p = userProps[v.key ?? ''];
      return typeof p === 'boolean' ? p : v.value;
    }
    case 'script':
      return v.value;
    default:
      // 畸形 kind（运行时防御，解析器产出恒为上述三值）→ 默认可见，不误杀对象
      return true;
  }
}
