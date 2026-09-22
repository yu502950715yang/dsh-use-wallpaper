// 合成壁纸库：用 makePkg / makeTex 在内存里构造覆盖五类用例的 scene.pkg。
// 供确定性回归测试使用 —— 不依赖本机 workshop 库、不入库二进制、内容全为本仓库自有。
//
// 覆盖：① image 链路（model→material→tex，含「同目录」与「含 / 相对 materials/」两种布局）
//      ② particle 规格（emitter + 含 rotationrandom 的 initializer）
//      ③ 线性效果链（单 pass / 双 pass 走 previous）
//      ④ 具名 RT 图链（多 pass + target + bind + fbos 降采样）
//      ⑤ util 对象带 effects（不渲染但必须照常解析链）
import { Buffer } from 'node:buffer';
import { makePkg } from '../make-pkg.js';
import { makeTex } from '../make-tex.js';

export interface SyntheticWallpaper {
  id: string;
  pkg: Buffer;
  /** pkg 内文件表（name → 字节），与生产 `loadFile` 的语义一致。 */
  files: Map<string, Uint8Array>;
}

const enc = (s: string) => new TextEncoder().encode(s);
const json = (o: unknown) => enc(JSON.stringify(o));

/** RGBA8888 纹理（format 0），data = w×h×4 原始字节。 */
function rgbaTex(w: number, h: number): Buffer {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 7) & 0xff;
    data[i * 4 + 1] = (i * 13) & 0xff;
    data[i * 4 + 2] = (i * 29) & 0xff;
    data[i * 4 + 3] = 255;
  }
  return makeTex({ format: 0, images: [[{ width: w, height: h, data }]] });
}

// 最小 WE 方言 shader（自有，非第三方素材）。synmask 带 sampler 注解，
// 用于钉住「combo 派生 + sampler mode」这两条最容易出真机 bug 的语义。
const SHADER_PLAIN_VERT = `#include "common.h"
uniform mat4 g_ModelViewProjectionMatrix;
attribute vec3 a_Position;
attribute vec2 a_TexCoord;
varying vec2 v_TexCoord;
void main() {
    gl_Position = mul(vec4(a_Position, 1.0), g_ModelViewProjectionMatrix);
    v_TexCoord = a_TexCoord;
}
`;

const SHADER_PLAIN_FRAG = `#include "common.h"
uniform sampler2D g_Texture0;
varying vec2 v_TexCoord;
void main() {
    gl_FragColor = texSample2D(g_Texture0, v_TexCoord);
}
`;

const SHADER_MASK_FRAG = `#include "common.h"
uniform sampler2D g_Texture0;
uniform sampler2D g_Texture1; // {"mode":"opacitymask","combo":"MASK","default":"util/white"}
varying vec2 v_TexCoord;
void main() {
#if MASK
    float mask = texSample2D(g_Texture1, v_TexCoord).r;
#else
    float mask = 1.0;
#endif
    gl_FragColor = texSample2D(g_Texture0, v_TexCoord) * mask;
}
`;

function pack(id: string, scene: unknown, files: Array<{ name: string; data: Uint8Array }>): SyntheticWallpaper {
  const entries = [{ name: 'scene.json', data: json(scene) }, ...files];
  return {
    id,
    pkg: makePkg(entries),
    files: new Map(entries.map((e) => [e.name, e.data])),
  };
}

const camera = { center: '100 100 0', eye: '100 100 1', up: '0 1 0' };
const general = (w: number, h: number) => ({ orthogonalprojection: { width: w, height: h }, clearcolor: '0 0 0' });

/** ① 线性链 + image 链路 + particle + util 带链。 */
function linearWallpaper(): SyntheticWallpaper {
  const scene = {
    camera,
    general: general(200, 200),
    objects: [
      // 同目录贴图布局：textures[0] 不含 '/' → materials/bg.tex
      { id: 1, name: 'bg', image: 'models/bg.json', origin: '100 100 0', scale: '1 1 1', size: '200 200', visible: true },
      // particle：含 rotationrandom（F4 自旋的数据来源）
      { id: 2, name: 'petals', particle: 'particles/petals.json', origin: '60 60 0', scale: '1 1 1' },
      // ③-a 单 pass 线性链
      { id: 3, name: 'grain', image: 'models/grain.json', origin: '100 100 0', scale: '1 1 1', size: '200 200', effects: [{ file: 'effects/grain.json' }] },
      // ③-b 双 pass 线性链（第 2 pass 用 previous@0）
      { id: 4, name: 'two', image: 'models/two.json', origin: '100 100 0', scale: '1 1 1', size: '200 200', effects: [{ file: 'effects/two.json', passes: [{}, { bind: [{ name: 'previous', index: 0 }] }] }] },
      // ⑤ util 对象带 effects：不渲染，但链必须照常解析
      { id: 5, name: 'compose', image: 'models/util/composelayer.json', effects: [{ file: 'effects/grain.json' }] },
    ],
  };
  return pack('syn-linear', scene, [
    // image 链路：model → material → tex（同目录布局）
    { name: 'models/bg.json', data: json({ autosize: true, material: 'materials/bg.json' }) },
    { name: 'materials/bg.json', data: json({ passes: [{ shader: 'syn', blending: 'translucent', textures: ['bg'] }] }) },
    { name: 'materials/bg.tex', data: rgbaTex(4, 4) },
    // 含 '/' 的相对布局：textures[0]='sub/grain' → materials/sub/grain.tex
    { name: 'models/grain.json', data: json({ autosize: true, material: 'materials/grain.json' }) },
    { name: 'materials/grain.json', data: json({ passes: [{ shader: 'syn', blending: 'additive', textures: ['sub/grain'] }] }) },
    { name: 'materials/sub/grain.tex', data: rgbaTex(8, 8) },
    { name: 'models/two.json', data: json({ autosize: true, material: 'materials/two.json' }) },
    { name: 'materials/two.json', data: json({ passes: [{ shader: 'syn', blending: 'translucent', textures: ['two'] }] }) },
    { name: 'materials/two.tex', data: rgbaTex(4, 8) },
    // particle 规格
    {
      name: 'particles/petals.json',
      data: json({
        emitter: [{ rate: 8, distancemax: 128, directions: '0 1 0' }],
        initializer: [
          { name: 'lifetimerandom', min: 1, max: 2 },
          { name: 'rotationrandom', min: '-0.5 -0.5 -0.5', max: '0.5 0.5 0.5' },
          { name: 'angularvelocityrandom', min: '-2 -2 -2', max: '2 2 2' },
        ],
      }),
    },
    // 单 pass 线性链：effect.json → material → shader
    { name: 'effects/grain.json', data: json({ passes: [{ material: 'materials/grain_mat.json' }] }) },
    { name: 'materials/grain_mat.json', data: json({ passes: [{ shader: 'syn', blending: 'additive' }] }) },
    { name: 'shaders/syn.vert', data: enc(SHADER_PLAIN_VERT) },
    { name: 'shaders/syn.frag', data: enc(SHADER_PLAIN_FRAG) },
    // 双 pass 线性链：两个 material 各一个 pass（走同一份 shader）
    { name: 'effects/two.json', data: json({ passes: [{ material: 'materials/two_a.json' }, { material: 'materials/two_b.json' }] }) },
    { name: 'materials/two_a.json', data: json({ passes: [{ shader: 'syn', blending: 'normal' }] }) },
    { name: 'materials/two_b.json', data: json({ passes: [{ shader: 'syn', blending: 'translucent' }] }) },
  ]);
}

/** ④ 具名 RT 图链（target + bind + fbos），并带 mask 注解钉住 combo/sampler mode 语义。 */
function rtGraphWallpaper(): SyntheticWallpaper {
  const scene = {
    camera,
    general: general(1280, 720),
    objects: [
      {
        id: 1,
        name: 'blurred',
        image: 'models/rt.json',
        origin: '640 360 0',
        scale: '1 1 1',
        size: '1280 720',
        // 第 1 个 pass 覆写纹理槽：g_Texture1 被绑定 ⇒ 注解里的 combo MASK 应派生为 1
        effects: [{ file: 'effects/rt.json', passes: [{ textures: [null, 'util/noise'] }, {}] }],
      },
    ],
  };
  return pack('syn-rtgraph', scene, [
    { name: 'models/rt.json', data: json({ autosize: true, material: 'materials/rt.json' }) },
    { name: 'materials/rt.json', data: json({ passes: [{ shader: 'syn', blending: 'translucent', textures: ['rt'] }] }) },
    { name: 'materials/rt.tex', data: rgbaTex(4, 4) },
    {
      name: 'effects/rt.json',
      data: json({
        passes: [
          { material: 'materials/rt_a.json', target: '_rt_HalfBuffer' },
          { material: 'materials/rt_b.json', bind: [{ name: '_rt_HalfBuffer', index: 0 }] },
        ],
        fbos: [{ name: '_rt_HalfBuffer', scale: 2 }],
      }),
    },
    { name: 'materials/rt_a.json', data: json({ passes: [{ shader: 'synmask', blending: 'normal' }] }) },
    { name: 'materials/rt_b.json', data: json({ passes: [{ shader: 'syn', blending: 'additive' }] }) },
    { name: 'shaders/syn.vert', data: enc(SHADER_PLAIN_VERT) },
    { name: 'shaders/syn.frag', data: enc(SHADER_PLAIN_FRAG) },
    { name: 'shaders/synmask.vert', data: enc(SHADER_PLAIN_VERT) },
    { name: 'shaders/synmask.frag', data: enc(SHADER_MASK_FRAG) },
  ]);
}

export function buildSyntheticLibrary(): SyntheticWallpaper[] {
  return [linearWallpaper(), rtGraphWallpaper()];
}
