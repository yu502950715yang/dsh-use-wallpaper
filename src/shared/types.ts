// src/shared/types.ts —— 跨任务共享类型（Interfaces 原文）

export type WallpaperKind = 'scene' | 'video' | 'web' | 'image' | 'preset' | 'unknown';

// 路径探测结果（/wallpapers/probe）：Steam 库自动扫描的候选目录。
// kind='workshop'：壁纸目录（steamapps/workshop/content/431960）；
// kind='assets'：引擎目录（steamapps/common/wallpaper_engine）。
export type WallpaperPathKind = 'workshop' | 'assets';

export interface SteamPathCandidate {
  path: string;
  exists: boolean;   // 目录是否真实存在
  kind: WallpaperPathKind;
}

export interface ProbeResult {
  workshop: SteamPathCandidate[];
  assets: SteamPathCandidate[];
}

export interface WallpaperInfo {
  id: string;                  // workshop id（目录名）
  title: string;
  type: WallpaperKind;
  file?: string;               // project.json 的 file 字段
  hasPreviewGif: boolean;
  hasScene: boolean;           // 存在可用的场景包（标准 scene.pkg 或 file 指定的自定义名，preset 取依赖目录）
  /** 场景包内入口 json 名（WE 模板可能是 gifscene.json 等自定义名；仅 hasScene 时下发）。 */
  sceneEntry?: string;
  /** WE 预设壁纸（dependency）的依赖 id：type='preset' 时存在，场景资源与属性都来自该壁纸。 */
  presetOf?: string;
  previewUrl: string;          // `/wallpapers/media/${id}/preview`
}

export interface PkgEntry { name: string; offset: number; size: number; }

// 壁纸用户属性（v0.9 四类型）：project.json general.properties ∩ scene 中被 {user} 引用的键。
// usedBy = scene 引用路径归类；condition = 属性级启用表达式（见 client/user-bindings.ts）。
export type UserPropertyValue = boolean | number | string;
export interface UserBindingRef { name: string; condition?: string; }
interface UserPropertyBase {
  key: string;
  label: string;
  order: number;
  usedBy: string[];
  condition?: string;
}
export type WallpaperUserProperty =
  | (UserPropertyBase & { type: 'bool'; value: boolean })
  | (UserPropertyBase & { type: 'slider'; value: number; min: number; max: number; step?: number; precision?: number; fraction?: boolean })
  | (UserPropertyBase & { type: 'color'; value: string })
  | (UserPropertyBase & { type: 'combo'; value: string; options: Array<{ label: string; value: string }> });

// WE 对象可见性绑定（T4.2）：scene.json 的 visible 字段三种形态归一化——
//   true / false           → { kind:'plain', value }（静态开关）
//   { user, value }        → { kind:'user', key, condition?, value }（user 可为
//                            "name" 或 {name,condition}；键缺失回退 value（有无 condition 一致）；
//                            有 condition 时**匹配即可见、不匹配即隐藏**，与 value 无关；
//                            无 condition 时按用户布尔覆盖，值非布尔回退 value）
//   { script, value }      → { kind:'script', script, value }（脚本求值超出本期范围，
//                           可见性保持 value；script/scriptProperties 同时是 T3.3 视觉
//                           脚本输入——image 对象的 visualizer 识别走同一来源）
// 缺失/畸形 → undefined（无绑定 = 默认可见）。解析见 src/client/visibility.ts。
export interface VisibleBinding {
  kind: 'plain' | 'user' | 'script';
  value: boolean;                       // 缺省可见性（user 键缺失、无 condition 时值非布尔、script 未求值时回退）
  key?: string;                         // kind='user'：用户属性键名（scene.json 的 user）
  condition?: string;                   // kind='user'：绑定侧 condition（对象形态 user.condition）
  script?: string;                      // 可见性脚本源码（kind='script'；user 绑定也可同时携带，见 parseVisible）
  scriptProperties?: Record<string, unknown>; // 脚本参数（{user} 绑定装配前 resolve 为标量）
}

// 对象级脚本挂载的转换属性（WE 属性脚本 `update(value)` 的绑定目标）。
export type ObjectScriptProperty = 'angles' | 'origin' | 'scale' | 'color';

// 时间线可动画的属性（比对象级脚本多 alpha；Task 9/10 的时间线运行时用）。
export type TimelineProperty = 'alpha' | 'origin' | 'scale' | 'angles' | 'color';

// 单个对象属性脚本：四属性可各挂一个（scriptproperties 各自独立）。
export interface ObjectScriptEntry {
  property: ObjectScriptProperty;
  script: string;
  scriptProperties?: Record<string, unknown>;
}

// 对象级字段的 user 绑定引用（T4：解析期只记 ref，装配前 resolveSceneUserBindings 统一替换）。
export interface ObjectUserRefs {
  color?: UserBindingRef;
  alpha?: UserBindingRef;
  brightness?: UserBindingRef;
  origin?: UserBindingRef;
  scale?: UserBindingRef;
  angles?: UserBindingRef;
}

// 四种 kind 共有的对象字段（解析器 scene-json.ts 的 `base` 会 spread 进每个分支）：
// 新增与 kind 无关的对象级字段一律加在这里，避免四处声明漂移。
export interface SceneObjectBase {
  /** 对象字段的 user 绑定引用（静态值仍在原字段；装配前由 resolveSceneUserBindings 覆盖）。 */
  userRefs?: ObjectUserRefs;
  /** WE 对象级视差深度（scene.json `parallaxDepth`，两根轴）；缺省 = OWE 的 {0,0} ⇒ 不参与视差。 */
  parallaxDepth?: [number, number];
  /** 对象级属性脚本（angles/origin/scale/color 可各有一个）；visible.script 走 VisibleBinding。 */
  objectScripts?: ObjectScriptEntry[];
}

export interface SceneImageObject extends SceneObjectBase {
  kind: 'image'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  parent?: number;               // 场景树父对象 id（世界变换由 scene-graph 累积）
  // WE 对象欧拉角（**弧度**，原文即弧度 —— OWE `SceneNode.cpp:15`：`m_rotation is in radians.
  // Static scene.json angles are already radians`）。对象 model matrix = **T·R·S**，旋转顺序
  // R = Rz·Ry·Rx（OWE `ParticleRuntime.cpp:25-28` `ControlpointRotation`）。缺省 [0,0,0]。
  // 全库 79 个对象带非零 angles（粒子 75 / image 2 / text 1 / other 1），此前未解析 ——
  // GTR 3743126786 烟柱 `angles.z = -1.20063` 本应把「向上」转成「向右」。
  angles?: [number, number, number];
  size?: [number, number];       // scene.json 的 size 字段（WE 像素尺寸），缺省时由纹理宽高推算
  image: string;                 // 资源名，如 "models/xxx.json"
  visible?: VisibleBinding;      // T4.2：可见性绑定（渲染前解析，不可见对象跳过）
  alignment?: string;            // 对象对齐锚点（9 种 WE 对齐值：center/topleft/top/topright/right/bottomright/bottom/bottomleft/left；渲染时 origin 按锚点换算中心，见 alignment.ts）
  effects?: unknown[];           // 对象效果链定义（Ruling 5：全库 122 条效果中 105 条挂在 image 对象上）
  script?: string;               // visible.script（WE 可见性/视觉脚本源码，T3.3 模式识别输入）
  scriptProperties?: Record<string, unknown>; // visible.scriptproperties（{user} 绑定装配前 resolve，T3.3）
  // T4.3：对象调制字段（WE 语义）——color 为 "r g b"（0-255 量级，经 optColor 0-1/0-255
  // 双语义归一化启发，见 scene-json.ts）；alpha 为 0-1（>1 的百分比形态已按
  // NormalizeLayerAlpha 归一化 /100 并 clamp）；brightness 为纹理色乘法系数（缺省 1）。
  // 渲染调制 = 纹理 × color×brightness（0-1）、透明度 × alpha。text 对象 color 走既有
  // T3.1 路径（CanvasTexture 绘制时混色），不经本字段。
  color?: [number, number, number];
  alpha?: number;
  brightness?: number;
  // WE 图像颜色混合模式（scene.json 的 `colorBlendMode` → shader combo `BLENDMODE`）。
  // 语义：WE 会**额外追加一遍混合 pass**（材质 `materials/util/effectpassthrough.json`，
  // shader = `genericimage3`）：读当前帧缓冲 A，与自己颜色 B 做
  // `gl_FragColor.rgb = ApplyBlending(BLENDMODE, A, B, 自己的 alpha)`（`shaders/common_blending.h`），
  // alpha 保持背景的。缺省 0 = Normal（不追加 pass，走普通 alpha 混合）。
  // 全库非零的只有 3 个对象：3743126786 Clouds Back=7(Screen)、2832263418 audio_rainbow=6(Lighten)、
  // 2460786246 Clock=31(A+B×opacity)。Screen 对纯黑返回 A → 黑底自然「消失」。
  colorBlendMode?: number;
  /** WE 动画层（scene.json `animationlayers`）：animation = MDLA 动画 id；visible=false 表示不应用。 */
  animationLayers?: Array<{ id: number; animation: number; rate: number; blend: number; visible: boolean }>;
}
export interface SceneParticleObject extends SceneObjectBase {
  kind: 'particle'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  parent?: number;               // 场景树父对象 id（世界变换由 scene-graph 累积）
  // WE 对象欧拉角（**弧度**，缺省 [0,0,0]）—— model matrix T·R·S 的 R（Rz·Ry·Rx）。
  // 粒子层用它把局部运动方向/发射点旋转到场景空间（全库 75 个粒子对象带非零 angles）。
  angles?: [number, number, number];
  particle: string;            // 资源名，如 "particles/presets/lightshafts.json"
  visible?: VisibleBinding;    // T4.2：可见性绑定（渲染前解析，不可见对象跳过）
  alignment?: string;          // 对象对齐锚点（同 image；渲染时按锚点换算中心，见 alignment.ts）
  effects?: unknown[];         // 对象效果链定义（Ruling 5：与 image/util 一致，按 objects 顺序展平）
  // scene.json 的 `instanceoverride`（对象级粒子实例覆盖）序列化后的 JSON 文本：WE 用它乘/覆盖
  // 粒子的 alpha/size/lifetime/speed/color（官方 `OverrideSpawnProgram`），并让 emitter rate
  // 乘 count（`SceneParticleObjectParser.cpp:264`）。JS 只解 `{user|script,value}` 编辑器包装，
  // 数值语义仍在 Rust（`parse_particle_override`）—— 避免两份语义漂移。
  // 回归背景：GTR 3743126786 的烟柱 `{alpha: 0.03, size: 2.09}` 就靠它把粒子压到几乎不可见。
  instanceOverrideJson?: string;
}
/** WE util 层四种类型：项目层 / 全屏层 / 合成层 / 纯色层（v0.8.2 F2 按 image 文件名映射）。 */
export type UtilLayerKind = 'project' | 'fullscreen' | 'compose' | 'solid';
// WE 内置合成层/全屏层/项目层对象（image 引用 models/util/*.json，pkg 内无此文件）。
// v0.8.2 起按 layerKind 走内置材质渲染（util-material.ts），effects 为后处理效果链。
export interface SceneUtilObject extends SceneObjectBase {
  kind: 'util'; id: number; name: string;
  layerKind: UtilLayerKind;      // 未知 image → 'fullscreen'（失败开放降级）
  origin: [number, number, number]; scale: [number, number, number];
  parent?: number;               // 场景树父对象 id（容器不渲染，但父链要靠它累积）
  // WE 对象欧拉角（弧度，缺省 [0,0,0]）——util/text 当前不参与几何变换，字段保留以与
  // scene-json 的 base 解析一致（全库各 1 个对象带非零 angles）。
  angles?: [number, number, number];
  size?: [number, number];       // WE 像素尺寸（与 image 对象一致）
  image: string;                 // 如 "models/util/composelayer.json"
  color?: [number, number, number]; // 0-255（0-1/0-255 双语义经 optColor 归一）
  alpha?: number;                // 0-1（optAlpha 归一化；缺省按 1.0）
  brightness?: number;           // 颜色乘法系数，缺省 1
  visible?: VisibleBinding;      // T4.2：可见性绑定（不可见 util 层跳过）
  effects?: unknown[];           // 对象效果链定义（effects 数组，v0.8.2 起挂 util 链）
}
// WE text 对象（T3.1/T3.3）：scene.json 携带 text 字段（{ script, scriptproperties, value }
// 对象，如 2937346640 的 VHS Time and Date）。T3.1 静态渲染 text.value（离屏 canvas
// 绘制 → CanvasTexture → 共享场景 quad）；T3.3 起 text.script 识别为 clock 时每帧
// 按 scriptProperties 生成时间文本刷新纹理（静态值仅作缺省）。
export interface SceneTextObject extends SceneObjectBase {
  kind: 'text'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  parent?: number;               // 场景树父对象 id（世界变换由 scene-graph 累积）
  // WE 对象欧拉角（弧度，缺省 [0,0,0]）——util/text 当前不参与几何变换，字段保留以与
  // scene-json 的 base 解析一致（全库各 1 个对象带非零 angles）。
  angles?: [number, number, number];
  size?: [number, number];       // WE 像素尺寸（与 image 对象一致）
  text: string;                  // text.value（缺省字符串，脚本动态文本的静态兜底）
  visible?: VisibleBinding;      // T4.2：可见性绑定（渲染前解析，不可见对象跳过）
  font?: string;                 // WE 字体名（可能是文件路径，如 fonts/Atami-Regular.otf）
  pointsize?: number;            // WE pointsize；像素字号 = pointsize × 4（OME TextPointSizeToPx）
  color?: [number, number, number]; // 文本颜色（WE color "r g b a" 的前 3 通道，0-255）
  alignment?: string;            // 对齐锚点（9 种 WE 值）；horizontalalign/verticalalign 缺省时由它推导
  horizontalAlign?: string;      // WE horizontalalign：文本框锚点/多行行对齐（left/center/right）
  verticalAlign?: string;        // WE verticalalign：origin 落在文本框哪条边（top/center/bottom）
  padding?: number;              // WE padding：文本框四周**等量**内边距（字体像素单位）
  // v0.8.2 F12：text 可见字段
  alpha?: number;                // 层透明度（optAlpha 归一化 0-1；缺省 1）
  brightness?: number;           // 文本亮度系数（缺省 1；>1 在 canvas 侧用叠加绘制近似）
  anchor?: string;               // 动态锚点（none/center/top/topright/right/... 9 值）；非 none 时优先于 alignment 族
  limitwidth?: boolean;          // 宽度限制开关（true 时按 maxwidth 按词换行）
  maxwidth?: number;             // 限宽（字体像素，与 measureText 同空间；单位待真机确认）
  script?: string;               // text.script（WE 文本脚本源码，T3.3 模式识别输入）
  scriptProperties?: Record<string, unknown>; // text.scriptproperties（{user} 绑定装配前 resolve，T3.3）
  effects?: unknown[];           // 对象效果链（与 image/particle 同语义，v0.8.1 起挂链）
}
export type SceneObject = SceneImageObject | SceneParticleObject | SceneUtilObject | SceneTextObject;

/** WE 相机视差配置（scene.json `general.cameraparallax*`；缺省全关/全 0，= OWE 解析器缺省）。 */
export interface ParallaxConfig {
  enabled: boolean;
  amount: number;
  delay: number;
  mouseInfluence: number;
}

/** WE 音频对象（scene.json object.sound）：多文件 + 音量 + 播放模式（对齐 OWE SoundParser）。 */
export interface SceneSoundObject {
  files: string[];                             // scene.json 对象 sound 数组（可能多文件）
  volume: number;                              // 0-1，缺省 1（OWE 解析时 clamp）
  playbackmode: 'loop' | 'random' | 'single';  // 缺省 loop
}

export interface SceneDescription {
  camera: { center: [number, number, number]; eye: [number, number, number]; up: [number, number, number] };
  orthogonal: { width: number; height: number };
  // 粒子透视相机参数（`general.fov` / `general.perspectiveoverridefov`）：
  // spec 带 `flags` perspective 位的粒子对象在 WE 里改用 `global_perspective` 相机渲染
  // （OWE `SceneParticleObjectParser.cpp:397-398`），其 fov/距离由这两个字段决定
  // （缺省 fov=50、perspectiveoverridefov=0 = 未覆盖 → 用固定 1000 距离反算 fov）。
  fov?: number;
  perspectiveOverrideFov?: number;
  /** 清屏色（scene.json `general.clearcolor`，已归一化到 0-255）。 */
  clearColor?: [number, number, number];
  /** 壁纸级 bloom（WE general.bloom*，`bloom:true` 才产出；v0.8.1 只支持 threshold/strength）。 */
  bloom?: { strength: number; threshold: number };
  /** general.bloom 的 user 绑定（解析期保留，装配前由 resolveSceneUserBindings 决定是否产出 bloom）。 */
  bloomUser?: UserBindingRef;
  /** general.cameraparallax 的 user 绑定（同上：装配前覆盖 parallax.enabled）。 */
  parallaxUser?: UserBindingRef;
  /** 相机视差总配置（scene.json `general.cameraparallax*`，缺省全 0）。 */
  parallax: ParallaxConfig;
  objects: SceneObject[];
  // 壁纸音频（T3.4/v0.8.1）：按 objects 顺序收集结构化 sound 对象（files/volume/playbackmode）；
  // 全库实测 sound 只挂在对象上（无根级字段），无 sound 时 undefined（渲染器跳过）。
  sounds?: SceneSoundObject[];
}
