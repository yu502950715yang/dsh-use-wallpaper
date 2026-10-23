import { parseUserRef } from './user-bindings.js';
// 视觉系脚本条数：脚本 `engine.registerAudioBuffers(64)` → 64 bin 频谱（与
// audio-input.ts 的 fftSize 128 → 64 bins 一致），渲染 64 条音频条。
export const VISUALIZER_BAR_COUNT = 64;
// 启发式识别（保持最小、可测试；fixture 已覆盖两个真实家族）：
//   visualizer：注册音频缓冲（registerAudioBuffers）+ 动态创建层（createLayer/
//     createLayerAsset）——Simple Visualizer 用 createLayer('models/bar.json') 造 64 条；
//   clock：new Date() + 月份数组（Jan./January 风格）+ 取时/分（getHours/getMinutes）
//     ——VHS Time and Date 即该形态；否则 null（静态对象，按 T3.1 原路径渲染）。
export function detectScriptPattern(src) {
    if (typeof src !== 'string')
        return null;
    if (src.includes('registerAudioBuffers') && (src.includes('createLayer') || src.includes('createLayerAsset'))) {
        return 'visualizer';
    }
    if (src.includes('new Date()') && /Jan\.|January/.test(src) && (src.includes('getHours') || src.includes('getMinutes'))) {
        return 'clock';
    }
    return null;
}
// 规范化单条 scriptproperty：WE 的 { user, value } 包装保留为 { value, user }（T4 装配前再
// resolve 成标量）；无 user 的 { value } 包装仍解包；其余原样。非 WE 包装缺 value 键时也原样。
function unwrapScriptProperty(v) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'value' in v) {
        const o = v;
        const user = parseUserRef(o.user);
        if (user) {
            const bound = { value: o.value, user };
            return bound;
        }
        return o.value;
    }
    return v;
}
// 规范化 WE scriptproperties JSON 对象（scene.json 已携带，直接读对象，不解析脚本源码）：
// 每条目可能为普通值或 { user, value } 包装 → 绑定保留 { value, user }，其余解包为内层值。
// 非对象输入（null/畸形）→ 空对象（渲染侧按缺省兜底，不抛错）。
export function parseScriptProperties(scriptProperties) {
    if (typeof scriptProperties !== 'object' || scriptProperties === null || Array.isArray(scriptProperties)) {
        return {};
    }
    const out = {};
    for (const [key, value] of Object.entries(scriptProperties)) {
        out[key] = unwrapScriptProperty(value);
    }
    return out;
}
// 时钟文本月份数组（getMonth() 0 基索引），与 VHS Time and Date 脚本逐字一致。
const CLOCK_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May.', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];
// 时钟文本生成（对齐 VHS Time and Date 脚本语义）：
//   24h：`HH:MM\nMon. D YYYY`（如 14:05\nAug. 21 2026）；
//   12h：`AM/PM HH:MM\nMon. D YYYY`（14 时 → PM 02:05；0 时 → AM 12:30，脚本 hours%=12 后 0→12）。
//   delimiter 取自 scriptProperties（缺省 ':'）；use24hFormat 缺省 true（脚本 addCheckbox 默认值）。
export function formatClockText(date, props) {
    const use24h = props.use24hFormat !== false;
    const delimiter = typeof props.delimiter === 'string' && props.delimiter ? props.delimiter : ':';
    const pad = (n) => ('00' + n).slice(-2);
    let hours = date.getHours();
    let meridiem = '';
    if (!use24h) {
        meridiem = hours < 12 ? 'AM' : 'PM';
        hours %= 12;
        if (hours === 0)
            hours = 12;
    }
    const timeLine = use24h
        ? `${pad(hours)}${delimiter}${pad(date.getMinutes())}`
        : `${meridiem} ${pad(hours)}${delimiter}${pad(date.getMinutes())}`;
    const dateLine = `${CLOCK_MONTHS[date.getMonth()]} ${date.getDate()} ${date.getFullYear()}`;
    return `${timeLine}\n${dateLine}`;
}
