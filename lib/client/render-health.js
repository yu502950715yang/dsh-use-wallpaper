// scene 实时渲染看护：失败分级记忆 + 装配/首帧耗时打点。
// 存储与时钟注入 ⇒ node 可测；硬失败落 localStorage（不可用时退化为会话内），软失败仅会话内。
// 硬失败分级的**唯一声明**（类型由该数组派生）：新增种类只改这里一处。
// 导出是为了让测试直接断言这份集合本身（而不是复制一份字面量）。
export const HARD_KINDS = ['scene-json', 'no-visible-objects', 'context-lost', 'exception'];
/** 硬失败 = 有证据表明「这张壁纸渲染不出来」⇒ 可落盘；软失败 = 可能是这次没供上 ⇒ 只记会话。 */
export function isHardFailure(kind) {
    return HARD_KINDS.includes(kind);
}
export const HEALTH_KEY_PREFIX = 'we:renderfail:';
const SCHEMA_VERSION = 1;
const DEFAULT_SOFT_COOLDOWN_MS = 3000;
/** 浏览器 localStorage；node/SSR 与隐私模式下取不到（或访问即抛）⇒ null，由会话内记忆兜底。 */
function defaultStorage() {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    }
    catch {
        return null;
    }
}
export function createRenderHealthStore(opts = {}) {
    const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    const now = opts.now ?? (() => Date.now());
    const cooldown = opts.softCooldownMs ?? DEFAULT_SOFT_COOLDOWN_MS;
    // 会话内记忆（不落盘）：硬失败兜底、软失败、自动重试闸、最近一次装配结果与计时。
    const hard = new Map();
    const soft = new Map();
    const retried = new Set();
    const session = new Map();
    const keyOf = (id) => HEALTH_KEY_PREFIX + id;
    const readStored = (id) => {
        if (!storage || !id)
            return null;
        let raw = null;
        try {
            raw = storage.getItem(keyOf(id));
        }
        catch {
            return null;
        }
        if (!raw)
            return null;
        try {
            const v = JSON.parse(raw);
            if (v?.v !== SCHEMA_VERSION || typeof v.kind !== 'string')
                return null;
            const kind = v.kind;
            if (!isHardFailure(kind))
                return null;
            return { kind, hard: true, at: Number(v.at) || 0, detail: String(v.detail ?? '') };
        }
        catch {
            return null;
        }
    };
    // 硬失败同时写会话内存与 localStorage：存储抛错（隐私模式/配额）时后者只是没落盘，判定不丢。
    const writeHard = (id, kind, detail) => {
        const entry = { kind, hard: true, at: now(), detail: String(detail).slice(0, 200) };
        hard.set(id, entry);
        if (!storage)
            return;
        try {
            storage.setItem(keyOf(id), JSON.stringify({
                v: SCHEMA_VERSION, kind: entry.kind, detail: entry.detail, at: entry.at,
            }));
        }
        catch { /* 配额/隐私模式：本次会话内仍然记得住 */ }
    };
    const currentHard = (id) => readStored(id) ?? hard.get(id) ?? null;
    return {
        recordHard(id, kind, detail) {
            if (!id)
                return; // 空 id = 还没选中壁纸，没有可归属的状态
            writeHard(id, kind, detail);
        },
        recordSoft(id, kind, detail) {
            if (!id)
                return;
            // 只记「这次没供上」，不覆盖最近一次装配结果（软失败不是装配结论）
            soft.set(id, { kind, detail: String(detail), at: now() });
        },
        recordOk(id, timing) {
            if (!id)
                return;
            soft.delete(id);
            session.set(id, { ok: true, timing });
        },
        clear(id) {
            hard.delete(id);
            soft.delete(id);
            retried.delete(id);
            session.delete(id);
            if (storage && id) {
                try {
                    storage.removeItem(keyOf(id));
                }
                catch { /* 记忆已清，落盘失败不影响 */ }
            }
        },
        clearAll() {
            // 只清失败记忆（硬/软/自动重试闸 + 落盘键）；session（成功结论与计时）不是失败记忆，保留。
            hard.clear();
            soft.clear();
            retried.clear();
            if (!storage)
                return;
            const keys = [];
            try {
                for (let i = 0; i < storage.length; i++) {
                    const k = storage.key(i);
                    if (k && k.startsWith(HEALTH_KEY_PREFIX))
                        keys.push(k);
                }
            }
            catch { /* 列举失败 ⇒ 没有可清的键 */ }
            for (const k of keys) {
                try {
                    storage.removeItem(k);
                }
                catch { /* 单个键清不掉就跳过 */ }
            }
        },
        snapshot(id) {
            const s = session.get(id);
            const timing = s?.timing ?? null;
            // failure = 失败记忆（硬失败优先，其次本次会话的软失败）；它与 ok 互不覆盖：
            // ok = 本次会话最近一次装配结果 ⇒「现在正常 + 曾失败过」可同时成立（面板两行设计的依据）。
            const hardHit = currentHard(id);
            const softHit = soft.get(id);
            const failure = hardHit
                ?? (softHit ? { kind: softHit.kind, hard: false, at: softHit.at, detail: softHit.detail } : null);
            return { wallpaperId: id, ok: s?.ok ?? null, failure, timing };
        },
        shouldAutoRetry(id) {
            if (!id || retried.has(id))
                return false;
            if (currentHard(id))
                return false; // 硬失败不自动重试（重试同一张渲染不出来的壁纸只会重复失败）
            const hit = soft.get(id);
            if (!hit)
                return false;
            return now() - hit.at >= cooldown;
        },
        markAutoRetried(id) { if (id)
            retried.add(id); },
    };
}
/** 面板状态行文案（不含 HTML）：三种状态各一句可读中文，不暴露原始枚举。 */
export function formatHealthLine(snap, t) {
    const timing = snap.timing ? formatTiming(snap.timing, t) : '';
    if (snap.failure) {
        const reason = FAILURE_TEXT[snap.failure.kind] ?? t('渲染失败');
        return t('上次失败：{reason}')
            .replace('{reason}', reason)
            + (snap.failure.hard ? t('（已记忆）') : t('（本次会话内记忆）'))
            + (timing ? ' · ' + timing : '');
    }
    if (snap.ok === true)
        return t('实时渲染正常') + (timing ? ' · ' + timing : '');
    return t('尚未渲染（选择一张 scene 壁纸后这里显示状态）');
}
// 首帧耗时 < 0 = 还没出帧（暂停态下会长期如此）⇒ 不渲染该字段，否则文案里会出现「首帧 -1 ms」。
function formatTiming(timing, t) {
    const assemble = t('装配 {assemble} ms').replace('{assemble}', String(Math.round(timing.assembleMs)));
    if (timing.firstFrameMs < 0)
        return assemble;
    return assemble + ' · ' + t('首帧 {first} ms').replace('{first}', String(Math.round(timing.firstFrameMs)));
}
// ⚠️ 这五条不经 t()：当前无 i18n 层（settings-section 的 weT 是恒等透传）；接入 i18n 时须一并翻译。
const FAILURE_TEXT = {
    'scene-json': '拿不到 scene.json',
    'no-visible-objects': '没有可显示的对象',
    'context-lost': 'WebGL 上下文丢失',
    'exception': '装配异常',
    'load-error': '资源加载中断',
};
