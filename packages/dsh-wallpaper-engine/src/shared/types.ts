// src/shared/types.ts —— 跨任务共享类型（Interfaces 原文）

export type WallpaperKind = 'scene' | 'video' | 'web' | 'image' | 'unknown';

export interface WallpaperInfo {
  id: string;                  // workshop id（目录名）
  title: string;
  type: WallpaperKind;
  file?: string;               // project.json 的 file 字段
  hasPreviewGif: boolean;
  hasScene: boolean;           // 存在 scene.pkg
  previewUrl: string;          // `/wallpapers/media/${id}/preview`
}

export interface PkgEntry { name: string; offset: number; size: number; }

// WE 对象可见性绑定（T4.2）：scene.json 的 visible 字段三种形态归一化——
//   true / false           → { kind:'plain', value }（静态开关）
//   { user, value }        → { kind:'user', key, value }（用户属性键；value 为缺省可见性）
//   { script, value }      → { kind:'script', script, value }（脚本求值超出本期范围，
//                           可见性保持 value；script/scriptProperties 同时是 T3.3 视觉
//                           脚本输入——image 对象的 visualizer 识别走同一来源）
// 缺失/畸形 → undefined（无绑定 = 默认可见）。解析见 src/client/visibility.ts。
export interface VisibleBinding {
  kind: 'plain' | 'user' | 'script';
  value: boolean;                       // 缺省可见性（user 键缺失 / script 未求值时的回退）
  key?: string;                         // kind='user'：用户属性键名（scene.json 的 user）
  script?: string;                      // kind='script'：脚本源码（T3.3 模式识别输入）
  scriptProperties?: Record<string, unknown>; // kind='script'：脚本参数（{user,value} 已解包）
}

export interface SceneImageObject {
  kind: 'image'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  size?: [number, number];       // scene.json 的 size 字段（WE 像素尺寸），缺省时由纹理宽高推算
  image: string;                 // 资源名，如 "models/xxx.json"
  visible?: VisibleBinding;      // T4.2：可见性绑定（渲染前解析，不可见对象跳过）
  alignment?: string;            // 对象对齐锚点（9 种 WE 对齐值：center/topleft/top/topright/right/bottomright/bottom/bottomleft/left；渲染时 origin 按锚点换算中心，见 alignment.ts）
  effects?: unknown[];           // 对象效果链定义（Ruling 5：全库 122 条效果中 105 条挂在 image 对象上）
  script?: string;               // visible.script（WE 可见性/视觉脚本源码，T3.3 模式识别输入）
  scriptProperties?: Record<string, unknown>; // visible.scriptproperties（{user,value} 已解包，T3.3）
}
export interface SceneParticleObject {
  kind: 'particle'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  particle: string;            // 资源名，如 "particles/presets/lightshafts.json"
  visible?: VisibleBinding;    // T4.2：可见性绑定（渲染前解析，不可见对象跳过）
  alignment?: string;          // 对象对齐锚点（同 image；渲染时按锚点换算中心，见 alignment.ts）
  effects?: unknown[];         // 对象效果链定义（Ruling 5：与 image/util 一致，按 objects 顺序展平）
}
// WE 内置合成层/全屏层/项目层对象（image 引用 models/util/*.json，pkg 内无此文件）。
// 语义是效果链容器/控制节点而非纹理：一期不渲染（跳过），effects 字段为二期
// 效果链（shader 后处理）渲染预留。
export interface SceneUtilObject {
  kind: 'util'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  size?: [number, number];       // WE 像素尺寸（与 image 对象一致）
  image: string;                 // 如 "models/util/composelayer.json"
  visible?: VisibleBinding;      // T4.2：可见性绑定（util 不渲染，字段无害保留）
  effects?: unknown[];           // 对象效果链定义（effects 数组，二期使用）
}
// WE text 对象（T3.1/T3.3）：scene.json 携带 text 字段（{ script, scriptproperties, value }
// 对象，如 2937346640 的 VHS Time and Date）。T3.1 静态渲染 text.value（离屏 canvas
// 绘制 → CanvasTexture → 共享场景 quad）；T3.3 起 text.script 识别为 clock 时每帧
// 按 scriptProperties 生成时间文本刷新纹理（静态值仅作缺省）。
export interface SceneTextObject {
  kind: 'text'; id: number; name: string;
  origin: [number, number, number]; scale: [number, number, number];
  size?: [number, number];       // WE 像素尺寸（与 image 对象一致）
  text: string;                  // text.value（缺省字符串，脚本动态文本的静态兜底）
  visible?: VisibleBinding;      // T4.2：可见性绑定（渲染前解析，不可见对象跳过）
  font?: string;                 // WE 字体名（可能是文件路径，如 fonts/Atami-Regular.otf）
  pointsize?: number;            // 字号（WE pointsize，绘制按 px 近似）
  color?: [number, number, number]; // 文本颜色（WE color "r g b a" 的前 3 通道，0-255）
  alignment?: string;            // 对齐方式（原始字段保留；静态渲染居中，暂不参与布局）
  script?: string;               // text.script（WE 文本脚本源码，T3.3 模式识别输入）
  scriptProperties?: Record<string, unknown>; // text.scriptproperties（{user,value} 已解包，T3.3）
}
export type SceneObject = SceneImageObject | SceneParticleObject | SceneUtilObject | SceneTextObject;

export interface SceneDescription {
  camera: { center: [number, number, number]; eye: [number, number, number]; up: [number, number, number] };
  orthogonal: { width: number; height: number };
  clearColor?: [number, number, number];
  objects: SceneObject[];
  // T3.4：壁纸音频。WE 音频对象（无 image/particle/text 的纯音频节点）携带 sound 数组
  // （资源名，如 2937346640 id=35 的 ["sounds/yutaka hirasaka - acro.flac"]）；
  // 全库实测 sound 只挂在对象上（无根级字段），解析器按 objects 顺序收集全部条目。
  // 无 sound 时缺省 undefined（渲染器 for..of desc.sounds ?? [] 跳过）。
  sounds?: string[];
}
