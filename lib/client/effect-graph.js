/** 单链具名 RT 软上限（全库实测最多 8 张；阈值高于实测，以免误杀库外正常链）。 */
export const NAMED_RT_LIMIT = 16;
export function namedRtKey(chainIndex, name) {
    return `${chainIndex}:${name}`;
}
/** fbos 未声明 / 非正数 / 非有限值 → 1（全尺寸）。 */
export function namedRtScale(fboScale, name) {
    const s = fboScale?.[name];
    return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
}
/** scale / base 非法（非有限 / ≤0）→ 按 1：导出 API 自身设防，不依赖调用方先归一。 */
export function namedRtSize(baseWidth, baseHeight, scale) {
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const w = Number.isFinite(baseWidth) && baseWidth > 0 ? baseWidth : 1;
    const h = Number.isFinite(baseHeight) && baseHeight > 0 ? baseHeight : 1;
    return {
        width: Math.max(1, Math.round(w / s)),
        height: Math.max(1, Math.round(h / s)),
    };
}
export function buildEffectPlan(chains, opts) {
    const baseW = Number.isFinite(opts.baseWidth) && opts.baseWidth > 0 ? opts.baseWidth : 1;
    const baseH = Number.isFinite(opts.baseHeight) && opts.baseHeight > 0 ? opts.baseHeight : 1;
    const namedTargets = [];
    const passes = [];
    const droppedChains = [];
    chains.forEach((chain, chainIndex) => {
        // ① 具名 RT 清单：按 target 建（fbos 只用来查 scale —— GTR 的 fbos 声明与 target 实际不一致）
        const names = [];
        for (const p of chain) {
            if (p.target && !names.includes(p.target))
                names.push(p.target);
        }
        if (names.length > NAMED_RT_LIMIT) {
            droppedChains.push(chainIndex);
            return;
        }
        const keyOf = new Map();
        for (const name of names) {
            const key = namedRtKey(chainIndex, name);
            keyOf.set(name, key);
            const size = namedRtSize(baseW, baseH, namedRtScale(chain[0]?.fboScale, name));
            namedTargets.push({ key, name, width: size.width, height: size.height });
        }
        // ② 逐 pass 的 bind 覆盖项与写端
        chain.forEach((p, passIndex) => {
            const bindings = [];
            const unresolvedBinds = [];
            for (const b of p.bind ?? []) {
                const name = (b.name ?? '').trim();
                if (name === 'previous') {
                    bindings.push({ slot: b.index, source: { type: 'previous' } });
                    continue;
                }
                const key = name ? keyOf.get(name) : undefined;
                if (key) {
                    bindings.push({ slot: b.index, source: { type: 'named', key } });
                    continue;
                }
                unresolvedBinds.push(name);
            }
            const writesNamed = p.target !== undefined && p.target !== null && p.target !== '' && keyOf.has(p.target);
            const planned = {
                chainIndex,
                passIndex,
                bindings,
                write: writesNamed ? { type: 'named', key: keyOf.get(p.target) } : { type: 'pingpong' },
                blendMode: p.blendMode,
            };
            if (p.target)
                planned.target = p.target;
            if (unresolvedBinds.length > 0)
                planned.unresolvedBinds = unresolvedBinds;
            passes.push(planned);
        });
    });
    // 整条计划的最后一个 pass：pingpong → final（named 保持，执行器据此把 lastOutput 设为该 RT）
    const last = passes[passes.length - 1];
    if (last && last.write.type === 'pingpong')
        last.write = { type: 'final' };
    return { namedTargets, passes, droppedChains };
}
