import { parseScriptProperties } from './script-patterns.js';
import { parseVisible } from './visibility.js';
function vec3(s) {
    if (typeof s !== 'string')
        return [0, 0, 0];
    const parts = s.trim().split(/\s+/).map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
// WE 对象 size 字段（"宽 高"），缺失/非法时返回 undefined（由渲染器回退纹理宽高）
function size2(s) {
    if (typeof s !== 'string')
        return undefined;
    const parts = s.trim().split(/\s+/).map(Number);
    if (parts.length < 2 || !isFinite(parts[0]) || !isFinite(parts[1]))
        return undefined;
    return [parts[0], parts[1]];
}
// scale 字段缺省/类型非法 → [1,1,1]（WE 语义：无缩放 = 原始尺寸）。
// 与 Rust 侧 scene.rs 的 unwrap_or([1.0,1.0,1.0]) 对齐——缺 scale 的 image 对象若按 [0,0,0]
// 解析，wasm 渲染器 image_half_ndc 会算出 quad 尺寸 0 → 主图不渲染（实测 3303428996 等 3 张壁纸）。
// 字符串部分 token（如 "2 2"）维持 vec3 的缺省 0 语义（与 Rust vec3_str 一致，z 不影响图片渲染）。
function scale3(s) {
    if (typeof s !== 'string')
        return [1, 1, 1];
    const parts = s.trim().split(/\s+/).map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
// 可选数值字段（text 对象的 pointsize 等）：数字/数字字符串 → 有限数值；否则 undefined
function optNum(s) {
    if (typeof s === 'number')
        return isFinite(s) ? s : undefined;
    if (typeof s !== 'string')
        return undefined;
    const n = Number(s.trim());
    return isFinite(n) ? n : undefined;
}
// 可选 alpha 字段（T4.3，WE NormalizeLayerAlpha 语义）：数值/数字字符串 → 有限值；
// 归一化规则：>1 视为 0-100 百分比 /100（"50" → 0.5，"100" → 1），随后 clamp 0-1
// （"200" → 2 → clamp 1；防御畸形数据）；缺省/非法 → undefined（渲染器按 1.0 处理）。
function optAlpha(s) {
    const n = optNum(s);
    if (n === undefined)
        return undefined;
    const a = n > 1 ? n / 100 : n;
    return Math.max(0, Math.min(1, a));
}
// 可选颜色字段（WE color 形如 "r g b a"）：取前 3 通道；非法 → undefined。
// I3 修复（双语义归一化启发）：WE 颜色存在两种序列化——0-255（常规）与 0-1 归一化
// （文本对象实测：2937346640 VHS Time and Date 的 color "1.00000 1.00000 1.00000" 为白色）。
// 判定：max 分量 ≤ 1 → 视为 0-1 语义 ×255（"1 1 1" → 255；"0 0 0" 不变；"0.5" → 127.5）；
// 否则保持 0-255 语义（"255 255 255" 不变）。下游 createTextTexture/ClockTextDriver
// 直用本输出拼 rgb(r,g,b)，归一化后白色文本不再退化为近黑 rgb(1,1,1)。
function optColor(s) {
    if (typeof s !== 'string')
        return undefined;
    const parts = s.trim().split(/\s+/).map(Number);
    if (parts.length < 3 || !isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2]))
        return undefined;
    const rgb = [parts[0], parts[1], parts[2]];
    if (Math.max(parts[0], parts[1], parts[2]) <= 1) {
        return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255];
    }
    return [rgb[0], rgb[1], rgb[2]];
}
// 脚本字段提取（T3.3）：WE 对象脚本挂在 image 的 visible / text 的 text 对象上，
// 形如 { script, scriptproperties, value }。scriptproperties 直接读 scene.json 对象
// （{user,value} 包装由 parseScriptProperties 解包），不解析脚本源码。
// T4.2 起 image 对象改从归一化 visible（kind==='script'）派生 script 字段
// （见 image 分支），本函数仅服务 text 对象（text.script / text.scriptproperties）。
function scriptFields(o) {
    const script = typeof o?.script === 'string' && o.script ? o.script : undefined;
    const scriptProperties = o?.scriptproperties !== undefined
        ? parseScriptProperties(o.scriptproperties)
        : undefined;
    return { script, scriptProperties };
}
// T3.4 sound 字段收集：WE 音频对象（无 image/particle/text 的纯音频节点，如
// 2937346640 id=35）携带 sound 数组（资源名列表，如 ["sounds/yutaka hirasaka - acro.flac"]）。
// PkgReader 全库 26 个 scene.pkg 实测：10 个含 sound 的壁纸全部为对象级 sound 数组
// （无根级 sound 字段）→ 按 objects 顺序收集所有对象 sound 数组的字符串条目；
// 非数组/非字符串条目过滤（畸形数据防御）。音频对象本身无可见内容，解析后仍落入
// 空粒子兜底（kind:'particle' particle:''，不渲染，与现状一致）。
function collectSounds(root) {
    const sounds = [];
    const objects = Array.isArray(root.objects) ? root.objects : [];
    for (const o of objects) {
        if (!Array.isArray(o?.sound))
            continue;
        for (const s of o.sound) {
            if (typeof s === 'string' && s)
                sounds.push(s);
        }
    }
    return sounds.length > 0 ? sounds : undefined;
}
export function parseSceneJson(raw) {
    const root = JSON.parse(raw);
    if (typeof root !== 'object' || root === null || Array.isArray(root)) {
        throw new Error('scene.json root must be an object');
    }
    const cam = root.camera ?? {};
    const gen = root.general ?? {};
    const ortho = gen.orthogonalprojection ?? {};
    const objects = (Array.isArray(root.objects) ? root.objects : []).map((o) => {
        const base = {
            id: Number(o.id ?? 0),
            name: String(o.name ?? ''),
            origin: vec3(o.origin),
            scale: scale3(o.scale),
            size: size2(o.size),
            // T4.2：可见性绑定归一化（布尔 / {user,value} / {script,value} → VisibleBinding；
            // 缺失/畸形 → undefined = 默认可见）。渲染器按 resolveVisibility 跳过不可见对象。
            visible: parseVisible(o.visible),
            // T4.1：对象对齐锚点（9 种 WE 对齐值）→ image/particle 对象（text 对象走
            // horizontalalign/verticalalign，另行处理；util 对象不渲染，字段无害保留）。
            // 渲染器按锚点换算中心（applyAlignment），缺省/非法 → undefined = center 无偏移。
            alignment: typeof o.alignment === 'string' && o.alignment ? o.alignment : undefined,
            // Ruling 5：所有对象（kind 不限）的 effects 按 objects 顺序保留（全库 122 条中 105 条在 image 对象上）
            effects: Array.isArray(o.effects) ? o.effects : undefined,
        };
        if (typeof o.particle === 'string' && o.particle) {
            return { ...base, kind: 'particle', particle: o.particle };
        }
        if (typeof o.image === 'string' && o.image) {
            // WE 内置合成层/全屏层/项目层（models/util/*.json）：pkg 内无此文件，
            // 对象是效果链容器/控制节点而非纹理 → 归类 util（渲染时跳过，effects 效果链渲染见二期）
            if (o.image.startsWith('models/util/')) {
                return {
                    ...base, kind: 'util', image: o.image,
                };
            }
            // T3.3/T4.2：image 对象的可见性脚本 visible.{script,scriptproperties}（如 Simple
            // Visualizer）由归一化 visible 派生——kind==='script' 时 script/scriptProperties
            // 照常产出（识别为 visualizer 时渲染器改走 64 条音频条路径，见 scene-renderer.ts）；
            // {user,value} 用户开关（kind==='user'）与布尔（kind==='plain'）不产生脚本字段。
            // T4.3：image 对象调制字段——color 复用 optColor 归一化启发（"1 1 1" → 255；
            // 0-255 量级保持），alpha 按 NormalizeLayerAlpha（>1 → /100，clamp 0-1），
            // brightness 乘法系数缺省 1（渲染器按 纹理 × color×brightness 调制，见
            // scene-renderer.ts materialModulation / wasm image_tint）。
            return {
                ...base, kind: 'image', image: o.image,
                color: optColor(o.color),
                alpha: optAlpha(o.alpha),
                brightness: optNum(o.brightness) ?? 1,
                ...(base.visible?.kind === 'script'
                    ? { script: base.visible.script, scriptProperties: base.visible.scriptProperties }
                    : {}),
            };
        }
        // Ruling P3-1（text 归类优先级）：o.text 为对象（非 null、非数组）→ kind:'text'。
        // 检查位置：image 检查之后、空粒子兜底之前；text.value 为缺省字符串（T3.3 起
        // text.script 识别为 clock 时动态生成，静态值仅作兜底）。此前这类对象落入
        // 空粒子兜底 → 不渲染（2937346640 的 VHS Time and Date id=182 即因此缺失）。
        if (typeof o.text === 'object' && o.text !== null && !Array.isArray(o.text)) {
            const t = o.text;
            return {
                ...base,
                kind: 'text',
                text: typeof t.value === 'string' ? t.value : '',
                font: typeof o.font === 'string' && o.font ? o.font : undefined,
                pointsize: optNum(o.pointsize),
                color: optColor(o.color),
                alignment: typeof o.alignment === 'string' && o.alignment ? o.alignment : undefined,
                // T3.3：text.script 识别为 clock 时每帧刷新时间文本（scriptproperties 已解包）
                ...scriptFields(t),
            };
        }
        return { ...base, kind: 'particle', particle: '' }; // 无引用对象按空粒子处理（不渲染）
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
        sounds: collectSounds(root),
    };
}
