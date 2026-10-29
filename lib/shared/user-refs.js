/** 绑定引用归一化：字符串 → {name}；对象取非空 name + 字符串 condition；缺失/畸形 → undefined。 */
export function parseUserRef(user) {
    if (typeof user === 'string')
        return user ? { name: user } : undefined;
    if (user && typeof user === 'object') {
        const o = user;
        if (typeof o.name === 'string' && o.name) {
            return { name: o.name, condition: typeof o.condition === 'string' ? o.condition : undefined };
        }
    }
    return undefined;
}
