// 动态网格的内置 shader 源。
//
// 顶点 shader 与 pkg 内 `shaders/we2d_particle_alpha.vert`（344 B）语义一致：标准 MVP + 直传 uv/color。
// alpha 层片元照抄 pkg 的 `we2d_particle_alpha.frag`（纹理 alpha 当遮罩，rgb 输出白）。
// **颜色层 `we2d_particle_mesh` 不在 pkg 内** → 按 alpha 层推断自实现（spec §6.2 已知偏差）：
// 纹理 rgb × 顶点 rgb，alpha = 纹理 a × 顶点 a。

// 顶点层：颜色层与 alpha 层共用（对应 pkg 的 we2d_particle_alpha.vert）。
//
// ⚠️ attribute 名必须用 three 的 built-in（`position` / `uv`）—— three 是**按名字**把 geometry 的
// attribute 绑给 shader 的，写成 WE 的 `a_Position` 会一个都绑不上（顶点恒为 0，画面什么都不显示，
// 且**不报错**）。变换也必须用 three 内建的 `projectionMatrix`/`modelViewMatrix`：WE 的
// `g_ModelViewProjectionMatrix` 没有人为它赋值，用它会得到全 0 矩阵。
// `color` 是 vec4，而 three 只在 `vertexColors: true` 时注入 vec3 的 color ⇒ 这里自己声明。
export const PARTICLE_MESH_VERT = `
attribute vec4 color;
varying vec2 v_TexCoord;
varying vec4 v_Color;
void main() {
  v_TexCoord = uv;
  v_Color = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// uv 修正：`g_Texture0Resolution = (内容宽, 内容高, 打包宽, 打包高)`，与 WE 的
// we2d_particle_alpha.frag 同义。**本期统一传 (1,1,1,1)**（尚未接 TEXV0005 padding 元数据）
// ⇒ 修正退化为恒等，既保住白图兜底铺满 quad，也保住「无 padding」这一常见情形。
// ⚠️ 有 padding 的真实纹理若也被传成 (1,1,1,1)，采样会溢到 padding（观感偏差，待接入元数据后修正）。
const UV_FIX = `
  vec2 mapped = g_Texture0Resolution.zw / g_Texture0Resolution.xy;
`;

/** 颜色层（pkg 内缺 we2d_particle_mesh → 内置推断实现）。 */
export const PARTICLE_MESH_FRAG = `
uniform sampler2D g_Texture0;
uniform vec4 g_Texture0Resolution;
varying vec2 v_TexCoord;
varying vec4 v_Color;
void main() {${UV_FIX}  vec4 c = texture2D(g_Texture0, v_TexCoord * mapped);
  gl_FragColor = vec4(c.rgb * v_Color.rgb, c.a * v_Color.a);
}
`;

/** alpha 层（pkg 内有同名源时优先用 pkg，这里作兜底）。 */
export const PARTICLE_ALPHA_FRAG = `
uniform sampler2D g_Texture0;
uniform vec4 g_Texture0Resolution;
varying vec2 v_TexCoord;
varying vec4 v_Color;
void main() {${UV_FIX}  vec4 c = texture2D(g_Texture0, v_TexCoord * mapped);
  gl_FragColor = vec4(1.0, 1.0, 1.0, c.a * v_Color.a);
}
`;
