import { readParallaxConfig } from './parallax.js';
import { parseScriptProperties } from './script-patterns.js';
import { parseTimelineAnimation } from './scene-timeline.js';
import { parseUserRef } from './user-bindings.js';
import { parseVisible } from './visibility.js';
// 变换字段（origin/scale/size/angles）的三种写法：
//   ① 字符串          —— 常规（"1200.000 777.500 0.000"）
//   ② { script, value } —— 脚本驱动旋转/位移（如 2911105183 obj358 的 angles）
//   ③ { animation, value } —— 关键帧轨道绑定（如 2597392171 obj251 的 origin）
// ②③ 都带作者写入的静态 `value`，它是当前可用的最好近似；**轨道播放本身未实现**（见 AGENT.md §7.16）。
// 回归：库内 42 处非字符串写法**全部**带 value（10 处落在会被渲染的 image/particle/text 上），
// 此前一律被丢成默认值 ⇒ 3798688689 的 text 从 (1983,751) 被挪到场景原点、2597392171 的粒子同理。
function transformString(s) {
    if (typeof s === 'string')
        return s;
    if (s && typeof s === 'object' && typeof s.value === 'string') {
        return s.value;
    }
    return undefined;
}
// 字段上的 user 引用：{ user: "k" } / { user: {name,condition}, value }；无绑定 → undefined。
function parseUserRefField(s) {
    if (!s || typeof s !== 'object' || Array.isArray(s))
        return undefined;
    return parseUserRef(s.user);
}
// 从对象字段挑出命中的 user 绑定（全空 → undefined，不产出空 userRefs）。
function pickUserRefs(o, fields) {
    const refs = {};
    let found = false;
    for (const field of fields) {
        const ref = parseUserRefField(o[field]);
        if (ref) {
            refs[field] = ref;
            found = true;
        }
    }
    return found ? refs : undefined;
}
function mergeUserRefs(a, b) {
    if (!a)
        return b;
    if (!b)
        return a;
    return { ...a, ...b };
}
// {user|script, value} 包装取内层值（alpha/brightness 等数值字段的静态兜底）。
function unwrapFieldValue(s) {
    if (s && typeof s === 'object' && !Array.isArray(s) && 'value' in s) {
        return s.value;
    }
    return s;
}
function vec3(s) {
    const str = transformString(s);
    if (str === undefined)
        return [0, 0, 0];
    const parts = str.trim().split(/\s+/).map(Number);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}
// WE 对象 size 字段（"宽 高"），缺失/非法时返回 undefined（由渲染器回退纹理宽高）
function size2(s) {
    const str = transformString(s);
    if (str === undefined)
        return undefined;
    const parts = str.trim().split(/\s+/).map(Number);
    if (parts.length < 2 || !isFinite(parts[0]) || !isFinite(parts[1]))
        return undefined;
    return [parts[0], parts[1]];
}
// scale 字段缺省/类型非法 → [1,1,1]（WE 语义：无缩放 = 原始尺寸）。
// 缺 scale 的 image 对象若按 [0,0,0] 解析，quad 尺寸会算成 0 → 主图不渲染（实测 3303428996 等 3 张壁纸）。
// 字符串部分 token（如 "2 2"）维持 vec3 的缺省 0 语义（z 不影响图片渲染）。
function scale3(s) {
    const str = transformString(s);
    if (str === undefined)
        return [1, 1, 1];
    const parts = str.trim().split(/\s+/).map(Number);
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
// 可选字符串字段（text 的 horizontalalign/verticalalign 等）：非空字符串 → 原值；否则 undefined
function optStr(s) {
    return typeof s === 'string' && s.trim() ? s : undefined;
}
// 可选布尔字段（text 的 limitwidth）：布尔或 "true"/"false"（大小写不敏感）→ 布尔；否则 undefined
function optBool(s) {
    if (typeof s === 'boolean')
        return s;
    if (typeof s !== 'string')
        return undefined;
    const v = s.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : undefined;
}
// v0.8.2 F12 text 可见字段（两种 text 形态共用）：alpha 复用 optAlpha，brightness 缺省 1（同 image/util）；
// anchor 原样（"none" 由渲染侧回退）、limitwidth 布尔、maxwidth 字体像素。非法字段各自忽略。
function textVisibleFields(o) {
    return {
        alpha: optAlpha(o.alpha),
        brightness: optNum(unwrapFieldValue(o.brightness)) ?? 1,
        anchor: optStr(o.anchor),
        limitwidth: optBool(o.limitwidth),
        maxwidth: optNum(o.maxwidth),
    };
}
// WE 动画层（scene.json `animationlayers`）：id/animation 必需（缺任一 ⇒ 整条跳过，不产出半截层）；
// rate/blend 缺省 1、visible 缺省 false（出处 lwe `ObjectParser.cpp:284`，与 WE `visible{true}` 的差异见 AGENT.md §7.40）。非数组 → undefined。
function parseAnimationLayers(raw) {
    if (!Array.isArray(raw))
        return undefined;
    const out = [];
    for (const item of raw) {
        if (typeof item !== 'object' || item === null)
            continue;
        const o = item;
        const id = optNum(o.id);
        const animation = optNum(o.animation);
        if (id === undefined || animation === undefined)
            continue;
        out.push({
            id,
            animation,
            rate: optNum(o.rate) ?? 1,
            blend: optNum(o.blend) ?? 1,
            visible: o.visible === true,
        });
    }
    return out;
}
// WE image 实例声明（scene.json `instance`）：`textures` = 实例纹理槽，`usertextures` = 系统纹理
// （`$mediaThumbnail` = 当前播放封面）。畸形条目逐项丢弃；两侧都无有效值 ⇒ undefined。
function parseInstance(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return undefined;
    const o = raw;
    const textures = Array.isArray(o.textures)
        ? o.textures.filter((t) => typeof t === 'string' && !!t)
        : undefined;
    const usertextures = Array.isArray(o.usertextures)
        ? o.usertextures
            .map((u) => (u && typeof u === 'object'
            ? {
                name: String(u.name ?? ''),
                type: String(u.type ?? ''),
            }
            : null))
            .filter((u) => !!u && !!u.name)
        : undefined;
    if ((!textures || textures.length === 0) && (!usertextures || usertextures.length === 0))
        return undefined;
    return {
        ...(textures && textures.length > 0 ? { textures } : {}),
        ...(usertextures && usertextures.length > 0 ? { usertextures } : {}),
    };
}
// WE 对象级 parallaxDepth：两根轴的空格分隔字符串（与 origin/size 同形）；缺省/畸形 → undefined。
function optNum2(s) {
    if (typeof s !== 'string' || !s.trim())
        return undefined;
    const p = s.trim().split(/\s+/).map(Number);
    if (p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1]))
        return undefined;
    return [p[0], p[1]];
}
// 带缺省的数值字段（general.fov / perspectiveoverridefov）：数字/数字字符串 → 有限数值；
// 否则回退 WE 缺省（见调用处的 50 / 0）。`perspectiveoverridefov` 允许显式 0（= 未覆盖）。
function numOr(s, dflt) {
    const n = optNum(s);
    return n === undefined ? dflt : n;
}
// 可选 alpha 字段（T4.3，WE NormalizeLayerAlpha 语义）：数值/数字字符串 → 有限值；
// 归一化规则：>1 视为 0-100 百分比 /100（"50" → 0.5，"100" → 1），随后 clamp 0-1
// （"200" → 2 → clamp 1；防御畸形数据）；缺省/非法 → undefined（渲染器按 1.0 处理）。
function optAlpha(s) {
    const n = optNum(unwrapFieldValue(s));
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
    // color 也可能是**脚本驱动对象** `{script, scriptproperties, value}`（CodeTime id=54 的音频
    // 响应颜色）：不执行脚本时取 value，否则会退化成白色。
    const raw = (typeof s === 'object' && s !== null && typeof s.value === 'string')
        ? s.value
        : s;
    if (typeof raw !== 'string')
        return undefined;
    const parts = raw.trim().split(/\s+/).map(Number);
    if (parts.length < 3 || !isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2]))
        return undefined;
    const rgb = [parts[0], parts[1], parts[2]];
    if (Math.max(parts[0], parts[1], parts[2]) <= 1) {
        return [rgb[0] * 255, rgb[1] * 255, rgb[2] * 255];
    }
    return [rgb[0], rgb[1], rgb[2]];
}
// util 层类型按 image 文件名判定；未知 util（如 effectpassthrough）一律 fullscreen 直通降级。
function utilLayerKind(image) {
    if (image.includes('projectlayer'))
        return 'project';
    if (image.includes('composelayer'))
        return 'compose';
    if (image.includes('solidlayer'))
        return 'solid';
    return 'fullscreen';
}
// 脚本字段提取（T3.3）：WE 对象脚本挂在 image 的 visible / text 的 text 对象上，
// 形如 { script, scriptproperties, value }。scriptproperties 直接读 scene.json 对象
// （{user} 绑定保留为 {value,user}，装配前由 resolveSceneUserBindings 换成标量），不解析脚本源码。
// T4.2 起 image 对象改从归一化 visible（kind==='script'）派生 script 字段
// （见 image 分支），本函数仅服务 text 对象（text.script / text.scriptproperties）。
function scriptFields(o) {
    const script = typeof o?.script === 'string' && o.script ? o.script : undefined;
    const scriptProperties = o?.scriptproperties !== undefined
        ? parseScriptProperties(o.scriptproperties)
        : undefined;
    return { script, scriptProperties };
}
const OBJECT_SCRIPT_PROPS = ['angles', 'origin', 'scale', 'color', 'alpha'];
// 对象属性脚本：五个属性可各挂一个脚本（各自 scriptproperties 独立）。
// alpha 的脚本不带 update（只做媒体事件 + 播放该属性时间线）；仍按属性脚本装载，才能拿到
// `thisObject.getAnimation()` 的属性绑定语义（真实素材 3797976859 的淡入）。
function objectScriptsField(o) {
    const out = [];
    for (const property of OBJECT_SCRIPT_PROPS) {
        const v = o[property];
        if (!v || typeof v !== 'object' || Array.isArray(v))
            continue;
        const f = scriptFields(v);
        if (!f.script)
            continue;
        out.push({ property, script: f.script, ...(f.scriptProperties ? { scriptProperties: f.scriptProperties } : {}) });
    }
    return out.length > 0 ? { objectScripts: out } : {};
}
const ANIMATABLE = ['alpha', 'origin', 'scale', 'angles', 'color'];
// 属性时间线动画（scene.json 属性字段的 `animation` 块）：静态 value / script 字段各走原路径，这里只加动画数据。
// 无有效 c0 的属性不产出（回退静态值），因此不影响无动画壁纸。
function animationFields(o) {
    const out = {};
    for (const property of ANIMATABLE) {
        const field = o[property];
        if (!field || typeof field !== 'object' || Array.isArray(field))
            continue;
        const parsed = parseTimelineAnimation(property, field.animation);
        if (parsed)
            out[property] = parsed;
    }
    return Object.keys(out).length > 0 ? { animations: out } : {};
}
// sound 对象收集（T3.4/v0.8.1）：WE 音频节点携带 sound 文件数组；每对象产出结构化
// SceneSoundObject（volume 缺省 1 并 clamp 0-1，playbackmode 缺省 loop，对齐 OWE SoundParser）。
function collectSounds(root) {
    const out = [];
    for (const o of Array.isArray(root.objects) ? root.objects : []) {
        if (!Array.isArray(o?.sound))
            continue;
        const files = o.sound.filter((s) => typeof s === 'string' && !!s);
        if (files.length === 0)
            continue;
        const volume = typeof o.volume === 'number' && Number.isFinite(o.volume)
            ? Math.max(0, Math.min(1, o.volume))
            : 1;
        const mode = o.playbackmode === 'random' || o.playbackmode === 'single' ? o.playbackmode : 'loop';
        out.push({ files, volume, playbackmode: mode });
    }
    return out.length > 0 ? out : undefined;
}
// WE 的 {user|script, value} 编辑器包装：有效 user 绑定保留 {user,value} 交给 resolve；
// 其余（F21 的 user:null / script / 无值）仍递归解成内层 value（wasm 只认标量）。
function normalizeOverrideValue(v) {
    if (Array.isArray(v))
        return v.map(normalizeOverrideValue);
    if (v && typeof v === 'object') {
        const o = v;
        if ('value' in o && parseUserRef(o.user)) {
            return { user: o.user, value: normalizeOverrideValue(o.value) };
        }
        if ('value' in o && ('user' in o || 'script' in o))
            return normalizeOverrideValue(o.value);
        const out = {};
        for (const [k, x] of Object.entries(o))
            out[k] = normalizeOverrideValue(x);
        return out;
    }
    return v;
}
// scene.json 对象级 `instanceoverride`（粒子实例覆盖）→ **原始 JSON 文本**（供 wasm CPU 模拟器
// `parse_particle_override` 消费）。JS 侧不解析字段语义，只解 WE 编辑器写入的包装（F21）；非对象/数组/null/空对象 → undefined。
function serializeInstanceOverride(v) {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
        return undefined;
    try {
        const text = JSON.stringify(normalizeOverrideValue(v));
        return text && text !== '{}' ? text : undefined;
    }
    catch {
        return undefined;
    }
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
            // WE 对象欧拉角（**弧度**；缺省 [0,0,0]）= model matrix 的 R（T·R·S，R = Rz·Ry·Rx）。
            // 全库 79 个对象非零（粒子 75），此前**完全未解析** → 粒子运动方向/发射点、
            // 背景朝向都没经过对象旋转（GTR 烟柱 angles.z=-1.20063 本应把「向上」转成「向右」）。
            angles: vec3(o.angles),
            size: size2(o.size),
            // T4.2：可见性绑定归一化（布尔 / {user,value} / {script,value} → VisibleBinding；
            // 缺失/畸形 → undefined = 默认可见）。渲染器按 computeEffectiveVisibility（自身 condition + 父链）跳过不可见对象。
            visible: parseVisible(o.visible),
            // T4.1：对象对齐锚点（9 种 WE 对齐值）→ image/particle 对象（text 对象走
            // horizontalalign/verticalalign，另行处理；util 对象不渲染，字段无害保留）。
            // 渲染器按锚点换算中心（applyAlignment），缺省/非法 → undefined = center 无偏移。
            alignment: typeof o.alignment === 'string' && o.alignment ? o.alignment : undefined,
            // 场景树：子对象变换相对父节点（容器 `none` 对象也保留，世界变换由 scene-graph.ts 累积）
            parent: optNum(o.parent),
            // Ruling 5：所有对象（kind 不限）的 effects 按 objects 顺序保留（全库 122 条中 105 条在 image 对象上）
            effects: Array.isArray(o.effects) ? o.effects : undefined,
            // 对象级 parallaxDepth 与 kind 无关（全库 227 处：particle 106 / image 91 / text 20 / other 10），
            // 故落在 base 让所有分支都带出 —— Task 4 的粒子/文本注入 u_Parallax 全靠它。
            parallaxDepth: optNum2(o.parallaxDepth),
            // T4.4：origin/scale/angles 的 user 绑定保留（静态值照旧解析，供 resolve 缺失回退）。
            userRefs: pickUserRefs(o, ['origin', 'scale', 'angles']),
            // 转换字段里的对象属性脚本（angles/origin/scale/color 各一个）；无脚本的属性不产出条目。
            ...objectScriptsField(o),
            // 属性时间线动画（alpha/origin/scale/angles/color 的 animation 块）；无动画 ⇒ 不产出字段。
            ...animationFields(o),
        };
        // visible.script 的派生**与 kind 无关**（2026-09-22）：3798688689 的 3 个 SceneScript 总控
        // （92000 粒子 / 93000 拖尾 / 94000 场景控制器，后者 348 KB）**没有** image/particle/text
        // 字段，会落到本函数末尾的空粒子兜底分支 —— 只在 image/util 分支派生的话，这 3 个脚本会被
        // 静默丢掉（实测：原始 15 个 visible.script 对象，解析后只剩 12 个）。
        const fromVisibleScript = base.visible?.kind === 'script'
            ? { script: base.visible.script, scriptProperties: base.visible.scriptProperties }
            : {};
        if (typeof o.particle === 'string' && o.particle) {
            return {
                ...base,
                kind: 'particle',
                particle: o.particle,
                // 对象级粒子实例覆盖（alpha/size/lifetime/speed/color × emitter rate）——解包装后序列化交给 wasm。
                instanceOverrideJson: serializeInstanceOverride(o.instanceoverride),
                ...fromVisibleScript,
            };
        }
        if (typeof o.image === 'string' && o.image) {
            // WE 内置合成层/全屏层/项目层（models/util/*.json）：pkg 内无此文件，
            // 对象是效果链容器/控制节点而非纹理 → 归类 util（v0.8.2 起按 layerKind 走内置材质渲染）
            if (o.image.startsWith('models/util/')) {
                return {
                    ...base, kind: 'util', image: o.image,
                    layerKind: utilLayerKind(o.image),
                    // 调制字段与 image 对象同口径（optColor 双语义归一 / optAlpha clamp / brightness 缺省 1）
                    color: optColor(o.color),
                    alpha: optAlpha(o.alpha),
                    brightness: optNum(unwrapFieldValue(o.brightness)) ?? 1,
                    userRefs: mergeUserRefs(base.userRefs, pickUserRefs(o, ['color', 'alpha', 'brightness'])),
                    // util 不渲染纹理但**承载 SceneScript 控制器**（94001「切换按钮」、221591「双击切歌」）
                    ...fromVisibleScript,
                };
            }
            // T3.3/T4.2：image 对象的可见性脚本 visible.{script,scriptproperties}（如 Simple
            // Visualizer）由归一化 visible 派生——kind==='script' 时 script/scriptProperties
            // 照常产出（识别为 visualizer 时渲染器改走 64 条音频条路径，见 three-renderer.ts）；
            // {user,value} 用户开关（kind==='user'）与布尔（kind==='plain'）不产生脚本字段。
            // T4.3：image 对象调制字段——color 复用 optColor 归一化启发（"1 1 1" → 255；
            // 0-255 量级保持），alpha 按 NormalizeLayerAlpha（>1 → /100，clamp 0-1），
            // brightness 乘法系数缺省 1（渲染器按 纹理 × color×brightness 调制，见
            // scene-renderer.ts materialModulation / wasm image_tint）。
            return {
                ...base, kind: 'image', image: o.image,
                color: optColor(o.color),
                alpha: optAlpha(o.alpha),
                brightness: optNum(unwrapFieldValue(o.brightness)) ?? 1,
                userRefs: mergeUserRefs(base.userRefs, pickUserRefs(o, ['color', 'alpha', 'brightness'])),
                // WE 图像颜色混合模式（→ shader combo BLENDMODE；缺省 0 = Normal）。
                // 非数值/负数/非法 → 0（渲染侧只实现 6/7/31，其余回退普通 alpha 混合）。
                colorBlendMode: Math.max(0, Math.floor(optNum(o.colorBlendMode) ?? 0)),
                // T8：WE 动画层（puppet 的 MDLA 动画选择元数据）；undefined = 无该字段。
                animationLayers: parseAnimationLayers(o.animationlayers),
                // Task 8：实例纹理槽 / $mediaThumbnail（封面）声明。
                instance: parseInstance(o.instance),
                ...fromVisibleScript,
            };
        }
        // Ruling P3-1（text 归类优先级）：o.text 为对象（非 null、非数组）→ kind:'text'。
        // 检查位置：image 检查之后、空粒子兜底之前；text.value 为缺省字符串（T3.3 起
        // text.script 识别为 clock 时动态生成，静态值仅作兜底）。此前这类对象落入
        // 空粒子兜底 → 不渲染（2937346640 的 VHS Time and Date id=182 即因此缺失）。
        // text 为**字符串** = 静态文本、无脚本（CodeTime 的 "const" / "clock" / "={" / "}"）。
        // 此前只认对象形态 ⇒ 这类对象落入空粒子兜底、整行不渲染（2026-09-21 与桌面截图对照发现）。
        if (typeof o.text === 'string' && o.text) {
            return {
                ...base,
                kind: 'text',
                text: o.text,
                font: typeof o.font === 'string' && o.font ? o.font : undefined,
                pointsize: optNum(o.pointsize),
                color: optColor(o.color),
                userRefs: mergeUserRefs(base.userRefs, pickUserRefs(o, ['color', 'alpha', 'brightness'])),
                alignment: typeof o.alignment === 'string' && o.alignment ? o.alignment : undefined,
                // 图层尺寸/定位字段（两种 text 形态都要解析；缺省 → 由 alignment 推导）
                horizontalAlign: optStr(o.horizontalalign),
                verticalAlign: optStr(o.verticalalign),
                padding: optNum(o.padding),
                // v0.8.2 F12：alpha/brightness/anchor/limitwidth/maxwidth
                ...textVisibleFields(o),
            };
        }
        if (typeof o.text === 'object' && o.text !== null && !Array.isArray(o.text)) {
            const t = o.text;
            return {
                ...base,
                kind: 'text',
                text: typeof t.value === 'string' ? t.value : '',
                font: typeof o.font === 'string' && o.font ? o.font : undefined,
                pointsize: optNum(o.pointsize),
                color: optColor(o.color),
                userRefs: mergeUserRefs(base.userRefs, pickUserRefs(o, ['color', 'alpha', 'brightness'])),
                alignment: typeof o.alignment === 'string' && o.alignment ? o.alignment : undefined,
                horizontalAlign: optStr(o.horizontalalign),
                verticalAlign: optStr(o.verticalalign),
                padding: optNum(o.padding),
                ...textVisibleFields(o),
                // T3.3：text.script 识别为 clock 时每帧刷新时间文本（scriptproperties 的 {user,value} 保留到装配前 resolve）
                ...scriptFields(t),
            };
        }
        // 无 image/particle/text 的纯容器/控制器对象：不渲染，但**可能承载 SceneScript**
        // （见上方 fromVisibleScript 注释），故照常派生 script/scriptProperties。
        return { ...base, kind: 'particle', particle: '', ...fromVisibleScript };
    });
    // general.clearcolor 双语义：真实库为 0-1 归一化（如 "0.06667 0.07843 0.09412"），也兼容 0-255；
    // 判据同 optColor（max ≤ 1 ⇒ 视为 0-1 语义 ×255），player 接口仍按 0-255 使用。
    let cc = typeof gen.clearcolor === 'string' ? vec3(gen.clearcolor) : undefined;
    // 非有限值（"nan" / 畸形）不产出 clearColor ⇒ 走缺省黑（与 optColor 的 isFinite 口径一致）。
    if (cc && !(isFinite(cc[0]) && isFinite(cc[1]) && isFinite(cc[2])))
        cc = undefined;
    if (cc) {
        const max = Math.max(cc[0], cc[1], cc[2]);
        if (max > 0 && max <= 1)
            cc = [cc[0] * 255, cc[1] * 255, cc[2] * 255];
    }
    // 壁纸级 bloom（WE general.bloom*）：静态 true 才产出；缺省 strength=2 / threshold=0.65。
    // T4.4：{user,value} 形态保留 bloomUser，静态 value 仍作解析期兜底。
    const bloomUser = parseUserRefField(gen.bloom);
    const bloomStaticOn = gen.bloom === true
        || (typeof gen.bloom === 'object' && gen.bloom !== null && gen.bloom.value === true);
    const bloom = bloomStaticOn
        ? { strength: numOr(gen.bloomstrength, 2), threshold: numOr(gen.bloomthreshold, 0.65) }
        : undefined;
    // general.cameraparallax 的 {user,value} 同上：静态 value 先落 enabled，resolve 时按用户值覆盖。
    const parallaxUser = parseUserRefField(gen.cameraparallax);
    const parallax = readParallaxConfig(gen);
    if (parallaxUser && typeof gen.cameraparallax === 'object' && gen.cameraparallax !== null
        && gen.cameraparallax.value === true) {
        parallax.enabled = true;
    }
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
        // 粒子透视相机（2026-09-26）：`general.fov`（WE 缺省 50）与 `general.perspectiveoverridefov`
        // （缺省 0 = 未覆盖）。仅带 `flags` perspective 位的粒子对象用它（见 threejs-player）。
        fov: numOr(gen.fov, 50),
        perspectiveOverrideFov: numOr(gen.perspectiveoverridefov, 0),
        clearColor: cc,
        bloom,
        ...(bloomUser ? { bloomUser } : {}),
        ...(parallaxUser ? { parallaxUser } : {}),
        // 相机视差总开关与系数（general.cameraparallax*）；缺省全 0 = 与加此功能前观感一致。
        parallax,
        objects,
        sounds: collectSounds(root),
    };
}
// resolved color（0-255 三元组）→ "r g b" 0-1 字符串：optColor 对 max≤1 的值 ×255，
// 写 0-1 才能精确往返；写 0-255 会被再次归一（#010101 → [1,1,1] → 白）。
function formatColor01(rgb) {
    return [0, 1, 2]
        .map((i) => {
        const c = rgb[i];
        return String((Number.isFinite(c) ? c : 0) / 255);
    })
        .join(' ');
}
/**
 * 把 resolveSceneUserBindings 后的 color/alpha/brightness 写回原始 scene.json 文本。
 * loadSceneToThree 会重新 parseSceneJson，颜色必须写 0-1 字符串，避免 optColor 二次 ×255。
 * 不变量：player 侧能消费的可绑定字段必须在此写回（或经 SceneAssets 显式下发——origin/scale/
 * angles 走 worldTransforms、visible 走 effectiveVisible）；新增消费字段时先补这条路，否则静默用作者值。
 */
export function sceneJsonWithResolvedModulation(sceneJson, desc) {
    try {
        const root = JSON.parse(sceneJson);
        if (!Array.isArray(root.objects))
            return sceneJson;
        const byId = new Map(desc.objects.map((obj) => [obj.id, obj]));
        for (const raw of root.objects) {
            if (!raw || typeof raw !== 'object')
                continue;
            const rec = raw;
            const obj = byId.get(Number(rec.id ?? 0));
            const refs = obj?.userRefs;
            if (!obj || !refs)
                continue;
            const resolved = obj;
            if (refs.color && Array.isArray(resolved.color))
                rec.color = formatColor01(resolved.color);
            // alpha/brightness 是标量，按数值写回；重解析时 optAlpha 对 >1 仍按百分比 /100 并 clamp，
            // 只有 0-1 值能精确往返（brightness 走 optNum，不再缩放）。
            if (refs.alpha && resolved.alpha !== undefined)
                rec.alpha = resolved.alpha;
            if (refs.brightness && resolved.brightness !== undefined)
                rec.brightness = resolved.brightness;
        }
        return JSON.stringify(root);
    }
    catch {
        return sceneJson; // 畸形输入：保持原文（parseSceneJson 已成功过，正常走不到）
    }
}
