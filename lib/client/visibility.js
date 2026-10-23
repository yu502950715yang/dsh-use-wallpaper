import { parseScriptProperties } from './script-patterns.js';
import { matchCondition, parseUserRef, propertyConditionMet } from './user-bindings.js';
// 归一化 scene.json 的 visible 原始字段（任意 unknown）→ VisibleBinding。
// 规则：
//   布尔 → plain（原样保留）；
//   对象 → user 可解析（字符串或 {name,condition}）→ user 绑定（key/condition 保留，
//          value 取布尔或缺省 true）；否则含非空字符串 script → script 绑定
//          （script/scriptproperties 保留；scriptproperties 的 {user,value} 包装由
//          parseScriptProperties 解包）；
//   缺失/畸形（null/数组/数字/字符串/空对象）→ undefined（无绑定 = 默认可见，
//   不误杀对象）。
// value 缺省 true：WE 场景中 value 总是携带（true/false），缺失仅见于畸形数据，
// 保守取可见（渲染侧不因字段缺失丢失对象）。
export function parseVisible(raw) {
    if (typeof raw === 'boolean')
        return { kind: 'plain', value: raw };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return undefined;
    const o = raw;
    const value = typeof o.value === 'boolean' ? o.value : true;
    // user 优先于 script：同对象双键（畸形数据）时用户开关是更直接的控制
    const user = parseUserRef(o.user);
    if (user) {
        return {
            kind: 'user',
            key: user.name,
            ...(user.condition !== undefined ? { condition: user.condition } : {}),
            value,
        };
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
// 解析 user 绑定的布尔结果（isStaticallyHidden / resolveVisibility 共用）：
// 键缺失回退作者 value；有 condition 时匹配即可见（0=开、1=关 见 matchCondition），
// 无 condition 时保持历史口径（仅布尔覆盖，非布尔回退 value）。
function resolveUserVisibility(binding, userProps) {
    const key = binding.key;
    if (!key || !Object.hasOwn(userProps, key) || userProps[key] === undefined)
        return binding.value;
    const condition = binding.condition?.trim() || undefined;
    if (condition)
        return matchCondition(userProps[key], condition);
    const p = userProps[key];
    return typeof p === 'boolean' ? p : binding.value;
}
// 装载期静态隐藏判定（image / particle 的装载过滤用，2026-09-25）：
//   plain / user → 装载期即可定论（user 有 condition 时按条件判；无 condition 时键缺失/值非布尔回退 value）；
//   **script 恒返回 false** —— 这类对象的可见性是 visible.script 的每帧返回值
//   （SceneScriptHost → applyLayerState），装载期把它剔掉会让脚本永远无法打开它
//   （全库 9 个 image/particle 属此类，均带 value=false）。
// 与 resolveVisibility 的差别仅此一处：后者对 script 返回 value。该导出现仅单测使用；
// 渲染过滤点统一查 computeEffectiveVisibility 的 effectiveVisible 表。
export function isStaticallyHidden(binding, userProps) {
    if (!binding)
        return false;
    switch (binding.kind) {
        case 'plain':
            return !binding.value;
        case 'user':
            return !resolveUserVisibility(binding, userProps);
        case 'script':
            return false;
        default:
            // 畸形 kind（运行时防御）→ 不隐藏，不误杀对象
            return false;
    }
}
// 求对象最终可见性（纯函数，用户属性由调用方聚成 Record 注入）：
//   无绑定 → true（默认可见）；
//   plain → 原样；
//   user → 用户值覆盖绑定 value（condition 不匹配 → false；键缺失 → 回退 value）；
//   script → 保持 value（脚本求值（含已知模式）超出本期范围，见任务 brief）。
export function resolveVisibility(obj, userProps) {
    const v = obj.visible;
    if (!v)
        return true;
    switch (v.kind) {
        case 'plain':
            return v.value;
        case 'user':
            return resolveUserVisibility(v, userProps);
        case 'script':
            return v.value;
        default:
            // 畸形 kind（运行时防御，解析器产出恒为上述三值）→ 默认可见，不误杀对象
            return true;
    }
}
// 属性级 condition 不满足 → 属性不可用，回退作者 value（spec §4.1；渲染器当前无 project.json）。
function usableUserProps(userProps, defs) {
    if (!defs || defs.length === 0)
        return userProps;
    let out = userProps;
    for (const def of defs) {
        if (!def.condition || propertyConditionMet(def.condition, userProps))
            continue;
        if (out === userProps)
            out = { ...userProps };
        delete out[def.key];
    }
    return out;
}
// 对象有效可见性（装配期一次定论）：own && 父链继承（WE SceneNode 语义）。
// 父缺失 → 只按自身；环 → 视为可见防死循环；script 绑定不静态剔除（沿用 isStaticallyHidden）。
export function computeEffectiveVisibility(objects, userProps, defs) {
    const props = usableUserProps(userProps, defs);
    const byId = new Map(objects.map((o) => [o.id, o]));
    const cache = new Map();
    const visiting = new Set();
    const visit = (obj) => {
        const hit = cache.get(obj.id);
        if (hit !== undefined)
            return hit;
        if (visiting.has(obj.id))
            return true;
        visiting.add(obj.id);
        const self = !isStaticallyHidden(obj.visible, props);
        const parent = obj.parent === undefined ? undefined : byId.get(obj.parent);
        const result = self && (parent ? visit(parent) : true);
        visiting.delete(obj.id);
        cache.set(obj.id, result);
        return result;
    };
    for (const obj of objects)
        visit(obj);
    return cache;
}
