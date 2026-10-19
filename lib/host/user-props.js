const ORDER = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const stripHtml = (s) => s.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
/** 从 project.json + scene.json 收集可切换的布尔用户属性；坏 JSON / 缺字段返回 []，不抛。 */
export function collectVisibleBoolProperties(project, scene) {
    const props = project?.general?.properties;
    const objects = scene?.objects;
    if (typeof props !== 'object' || props === null || Array.isArray(props))
        return [];
    if (!Array.isArray(objects))
        return [];
    const visibleKeys = new Set();
    for (const obj of objects) {
        const user = obj?.visible?.user;
        if (typeof user === 'string' && user)
            visibleKeys.add(user);
    }
    const out = [];
    for (const [key, raw] of Object.entries(props)) {
        if (typeof raw !== 'object' || raw === null)
            continue;
        const def = raw;
        if (def.type !== 'bool' || def.editable === false || !visibleKeys.has(key))
            continue;
        out.push({
            key,
            label: stripHtml(typeof def.text === 'string' ? def.text : '') || key,
            type: 'bool',
            value: Boolean(def.value),
            order: ORDER(def.order),
        });
    }
    // order 浮点升序；同序按 key 码位（UTF-16 code unit）升序
    out.sort((a, b) => a.order - b.order || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
}
