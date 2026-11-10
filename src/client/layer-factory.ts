// 图层装配工厂（阶段 2c-2 起步）：从 ThreeScenePlayer 拆出的对象隔离装配（审查 P0-9）。
// 背景 / 粒子 / puppet 三种图层共用 attachIsolated；deps 由 player 注入（尺寸/渲染器状态/隔离表）。
import * as THREE from 'three';
import { CAMERA_DISTANCE, createCompositeGeometry, flipGeometryUvY } from './object-range.js';
import { applyCompositeSampling, createCompositeQuadMaterial } from './layer-material-factory.js';
import type { PuppetInstance } from './puppet.js';

// 对象隔离条目（对象级效果链）：带 effects 的对象不直接画进主场景，而是
//   ① 内容进 localScene（对象中心 = 局部原点），渲染到 rt；
//   ② 主场景放一张合成 quad 顶在对象原位置，采样「效果链输出」或「rt 原图」。
// 局部内容只保留 scale（含负值镜像），position/rotation 归零 —— 效果因此作用在对象**自身
// 纹理空间**，旋转与位移由合成 quad 承载。
// rtWidth/rtHeight/rtTexture 是给效果链编排器的扁平视图（免它通过 rt 再取一层）。
export interface IsolatedObject {
  /** 键 = scene.json 的**对象 id**（不是本类图层的计数器 id，见 attachIsolated 注释）。 */
  id: number;
  // puppet = 内容只在贴图空间跑效果链、输出直接当网格贴图（WE 语义）：没有主场景合成 quad，
  // 网格本身仍在主场景按骨骼动画绘制（见 addPuppet 的 isolate 注释）。
  kind: 'background' | 'particle' | 'puppet';
  rt: THREE.WebGLRenderTarget;
  rtWidth: number;
  rtHeight: number;
  rtTexture: THREE.Texture;
  localScene: THREE.Scene;
  localCamera: THREE.OrthographicCamera;
  /** 合成 quad（puppet 条目也建，但**不加入主场景**：只承载世界位置/旋转给 effectScreenMatrix 与释放）。 */
  quad: THREE.Mesh;
  /** 合成 quad 是否真的挂在主场景（puppet = false）。 */
  quadAttached: boolean;
  /** puppet 条目：效果链输出要写回它的材质 map（见 setObjectOutput）。 */
  puppet?: PuppetInstance;
  /** 合成 quad 的世界尺寸（= |对象 size/dist × scale|，未钳制幅值），resize 重建几何时用。 */
  worldW: number;
  worldH: number;
}

export interface AttachIsolatedDeps {
  sceneWidth: number;
  sceneHeight: number;
  screenScale: number;
  scene: THREE.Scene;
  isolated: Map<number, IsolatedObject>;
}

export interface AttachIsolatedArgs {
  objectId: number;
  kind: 'background' | 'particle' | 'puppet';
  content: THREE.Object3D;
  worldW: number;
  worldH: number;
  size: { width: number; height: number };
  position: { x: number; y: number; z: number };
  quadAngles: [number, number, number];
  colorBlendMode: number;
  /** 宿主对象的唯一绘制序（= objects 下标，调用方透传）；缺省按 kind 回退（背景 0 / 粒子 1）。 */
  renderOrder?: number;
  compositeOpacity?: number;
  // puppet：合成 quad 不挂主场景（输出直接当网格贴图），只保留世界位置供 effectScreenMatrix。
  attachQuad?: boolean;
  puppet?: PuppetInstance;
}

// 建立对象隔离条目：RT + 局部正交相机 + localScene + 主场景合成 quad；合成 quad 用
// createCompositeGeometry（世界尺寸含缩放、UV 按钳制窗口映射），position 承载对象世界位置。
//
// ⚠️ 第一个参数是 **scene.json 的对象 id**（键），不是图层计数器 id：背景层与粒子层各有
// 一个从 0 起的独立计数器，拿它们当键时（同一壁纸同时隔离 image 与 particle）后建的粒子条目会
// **覆盖**先建的背景条目 ⇒ 静默画错。用对象 id 才能与 ObjectEffectStage / wasm PendingChainStore
// 共用同一把键。
//
// ⚠️ 旋转的分工**不可「统一」**：quadAngles 由调用方按「RT 内容是否已含旋转」决定 —— 背景内容
// 不旋转（quad 承载对象 angles）；粒子内容 shader 已施加 objAngles（quadAngles 传 [0,0,0]，
// 否则同一份旋转被施加两次）。
//
// compositeOpacity（缺省 1）只由 util 层传对象 alpha：其内容占位透明、效果输出自带 alpha，
// 对象 alpha 只能在最终合成这一步收口；image/particle 的 alpha 已烘进 RT，不得二次施加。
export function attachIsolated(deps: AttachIsolatedDeps, args: AttachIsolatedArgs): void {
  const {
    objectId, kind, content, worldW, worldH, size, position, quadAngles, colorBlendMode,
    renderOrder, compositeOpacity = 1, attachQuad = true, puppet,
  } = args;
  const rtW = Math.max(1, Math.round(size.width));
  const rtH = Math.max(1, Math.round(size.height));
  // MSAA 分型：只有「整块盖满 RT 的 flat content」内部没有轮廓边、MSAA 结构性无效 ⇒ 关掉；
  // 粒子 billboard 即使铺满整屏也**有硬边**，必须保留。
  // puppet 内容 = 贴图平面、铺满 RT（无几何边）⇒ 同样关掉：源分辨率 RT（3840×2160）下 4×MSAA
  // 的显存代价不可接受，而画面逐像素无差异。
  const isFlatContent = (kind === 'background'
    && Math.abs(worldW) >= deps.sceneWidth * 0.98 && Math.abs(worldH) >= deps.sceneHeight * 0.98)
    || kind === 'puppet';
  const rt = new THREE.WebGLRenderTarget(rtW, rtH, { samples: isFlatContent ? 0 : 4 });
  // 合成采样标志（缩小采样必须开 mipmap）——与 resizeObjectRT 共用同一处判定。
  applyCompositeSampling(rt, worldW, worldH, deps.screenScale);
  // ⚠️ 局部正交相机的 left/right/top/bottom 是**世界坐标范围**，必须覆盖**完整对象世界尺寸**；
  // RT 像素尺寸只决定分辨率（object-range.isolatedRtSize：≥ 屏占位、源纹理收口 4096）。两个坑：
  //   ① 拿 RT 像素当相机范围 → dpr>1 时相机多覆盖 dpr 倍 ⇒ 内容只占 RT 的 1/dpr、四周空白，
  //      合成 quad 再按全窗口拉回世界尺寸 ⇒ 对象缩小 + 边缘 clamp 拉伸；
  //   ② 把相机范围钳到 OBJECT_RT_MAX → UV 窗口外侧被 CLAMP 采样成**边缘拉伸带**。
  // 超限对象的代价只能是**分辨率低**（欠采样），硬上限属于 RT **像素**尺寸，由 isolatedRtSize 收口。
  const camW = Math.max(1, Math.abs(worldW));
  const camH = Math.max(1, Math.abs(worldH));
  // ⚠️ **y 镜像局部相机**（top = -camH/2 < bottom = +camH/2）：对象 RT 是**效果链的输入**，效果
  // shader（WE 明文 GLSL）把 `v_TexCoord.y` 当**图像空间**纵坐标用（带符号位移 / 旋转滚动 UV），
  // 而 WE/lwe 的纹理约定是 `.tex` 首行落在 v=0（图像顶部，`CTexture.cpp:84` 直接上传、无翻转）
  // ⇒ WE 里 v 沿图像**向下**增长。three 显示路径把 `.tex` 翻成 v=0=图像底部，对象 RT 若沿用该
  // 约定，效果链里 v 就沿图像**向上**增长 ⇒ 位移/滚动的纵分量整体上下颠倒（AGENT.md §5.20）。
  // 这里把局部场景整体 y 镜像 ⇒ RT 的 v=0 = 图像顶部（与 WE 一致），再由合成 quad 的
  // `flipGeometryUvY` 翻回显示约定贴回主场景 ⇒ **画面不颠倒**（镜像与反镜像精确抵消）。
  // 副作用（已处理）：投影 y 取负会翻转**屏幕空间绕序** ⇒ 内容材质必须双面渲染。
  const localCamera = new THREE.OrthographicCamera(-camW / 2, camW / 2, -camH / 2, camH / 2, -1000, 1000);
  localCamera.position.z = CAMERA_DISTANCE;
  const localScene = new THREE.Scene();
  // 内容 mesh 保留原有（已烘调制的）材质：调制必须继续烘进 RT，只是合成 quad 不再重复施加。
  localScene.add(content);
  // 合成 quad 的材质独立构造、采样对象 RT 纹理（效果链就绪后由 setObjectOutput 换成效果输出）。
  // 几何世界尺寸 = 未钳制的 worldW/worldH；UV 窗口按**相机覆盖的世界范围**（camW/camH）映射，
  // 钳制轴只采样 RT 可见段；再 `flipGeometryUvY` 把 RT 的 WE 约定翻回显示约定。
  const compositeGeometry = createCompositeGeometry(worldW, worldH, camW, camH);
  flipGeometryUvY(compositeGeometry);
  const quad = new THREE.Mesh(
    compositeGeometry,
    createCompositeQuadMaterial(rt.texture, colorBlendMode, compositeOpacity),
  );
  quad.position.set(position.x, position.y, position.z);
  quad.rotation.set(quadAngles[0], quadAngles[1], quadAngles[2]);
  // 合成 quad 的绘制序跟随宿主对象；缺省沿原语义（背景 0 / 粒子 1）。
  quad.renderOrder = renderOrder ?? (kind === 'particle' ? 1 : 0);
  // puppet 条目：quad 只当「世界位置/旋转的载体」给 effectScreenMatrix，**不进主场景**（否则整张贴图
  // 会平铺在人物外面）；人物的绘制仍由主场景里的 SkinnedMesh 承担。
  if (attachQuad) deps.scene.add(quad);
  // 键 = scene.json 的对象 id（调用方传入），不是本类自己的图层计数器 id——见本函数头注释。
  deps.isolated.set(objectId, {
    id: objectId, kind, rt, rtWidth: rtW, rtHeight: rtH, rtTexture: rt.texture,
    localScene, localCamera, quad, quadAttached: attachQuad, puppet, worldW, worldH,
  });
}
