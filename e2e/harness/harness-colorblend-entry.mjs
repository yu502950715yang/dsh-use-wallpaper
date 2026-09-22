// colorBlendMode 渲染对比 harness 的入口（由 e2e/verify/verify-colorblend.mjs 用 esbuild 打包成
// 自包含 bundle，避免浏览器侧 bare specifier（three / lz4js）解析问题）。
// 渲染两个场景对比：?mode=7（Screen 混合）vs ?mode=0（旧行为 = 普通 alpha 混合）。
import * as THREE from 'three';
import { loadSceneToThree } from '../../lib/client/threejs-player.js';

const mode = Number(new URLSearchParams(location.search).get('mode') ?? '7');
const W = 800;
const H = 400;

// 背景纹理：程序化渐变（阶梯）—— 左半 0.30、右半 0.60，便于逐像素判定"背景有没有被压暗"。
const bgData = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const v = x < W / 2 ? 77 : 153; // 0.30 / 0.60 × 255
    const o = (y * W + x) * 4;
    bgData[o] = v; bgData[o + 1] = v; bgData[o + 2] = v; bgData[o + 3] = 255;
  }
}
const bgTex = new THREE.DataTexture(bgData, W, H);
bgTex.colorSpace = THREE.SRGBColorSpace;
bgTex.needsUpdate = true;

// 云层纹理：真实 clouds.tex 的解码结果（2048×2048，78% 纯黑 + 白云）
const cloudsTex = await new THREE.TextureLoader().loadAsync('/clouds.png');
cloudsTex.colorSpace = THREE.SRGBColorSpace;

const sceneJson = JSON.stringify({
  general: { orthogonalprojection: { width: W, height: H } },
  objects: [
    { id: 1, name: 'bg', image: 'models/bg.json', origin: `${W / 2} ${H / 2} 0`, size: `${W} ${H}` },
    {
      id: 2, name: 'Clouds Back', image: 'models/clouds.json',
      origin: `${W / 4} ${H / 2 + 40} 0`, size: `${W / 2} ${H - 80}`,
      alpha: 0.5, colorBlendMode: mode,
    },
  ],
});

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);
const result = loadSceneToThree(sceneJson, {
  backgroundTextures: new Map([[1, bgTex], [2, cloudsTex]]),
}, canvas, { width: W, height: H });
result.player.render();

// 采样判定点（canvas 2D 读像素，避免 WebGL preserveDrawingBuffer 依赖）
const probe = document.createElement('canvas');
probe.width = W;
probe.height = H;
const ctx = probe.getContext('2d');
ctx.drawImage(canvas, 0, 0);
const pick = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
// 云层矩形：origin(200,240) size(400,320) → 世界 x∈[0,400] y∈[80,400]
//   → 屏幕 x∈[0,400]、y∈[0,320]（y 轴翻转）。
// clouds 纹理 flipY 后 v=0 对应图像底部：图像下半 60% 是纯黑 → 屏幕 y∈[128,320] 为黑底。
const samples = {
  inCloudBlack: pick(200, 280), // 云层内、纹理纯黑底
  inCloudTop: pick(200, 100),   // 云层内、白云处
  bgLeftRef: pick(200, 380),    // 云层正下方、同一列的**纯背景**（判定基准：黑底应与它一致）
  bgRightRef: pick(600, 200),   // 云层外的右侧背景（对照，不应被任何东西影响）
};
console.log('[probe] ' + JSON.stringify({ mode, samples, layers: result.backgroundIds.length }));
document.title = 'ready';
