// 背景/puppet 装配（阶段 2c-3b）：从 ThreeScenePlayer 拆出（审查 P0-9）。
// 通过 host 注入图层簿记/隔离装配/精灵表/util 登记；不 import player。
import * as THREE from 'three';
import { materialModulation } from './object-range.js';
import { resolveUtilMaterial } from './util-material.js';
import { createLayerMaterial, createUtilLayerMaterial } from './layer-material-factory.js';
import { alignmentWorldOffset, type BackgroundEntry } from './background-layer-factory.js';
import { textureSpriteInfo } from './particle-assets.js';
import type { PuppetInstance } from './puppet.js';
import type { SceneImageObject, UtilLayerKind } from '../shared/types.js';

export interface PuppetLayerEntry {
  instance: PuppetInstance;
  layers: NonNullable<SceneImageObject['animationLayers']> | null;
  elapsed: number;
  warned?: boolean;
}

export interface BackgroundAssemblyHost {
  readonly scene: THREE.Scene;
  nextBackgroundId(): number;
  addEntry(id: number, entry: BackgroundEntry): void;
  attachIsolated(
    objectId: number,
    kind: 'background' | 'particle' | 'puppet',
    content: THREE.Object3D,
    worldW: number,
    worldH: number,
    size: { width: number; height: number },
    position: { x: number; y: number; z: number },
    quadAngles: [number, number, number],
    colorBlendMode: number,
    renderOrder?: number,
    compositeOpacity?: number,
    attachQuad?: boolean,
    puppet?: PuppetInstance,
  ): void;
  isolatedQuad(objectId: number): THREE.Object3D | undefined;
  setDisplayObject(objectId: number, shown: THREE.Object3D): void;
  setObjectToBackground(objectId: number, id: number): void;
  registerSpriteSheet(
    backgroundId: number,
    objectId: number,
    mesh: THREE.Mesh,
    sprite: { frames: number; cols: number; rows: number; frametime?: number },
  ): void;
  registerUtilContent(objectId: number, mesh: THREE.Mesh, centerX: number, centerY: number): void;
  setPuppetLayer(id: number, layer: PuppetLayerEntry): void;
}

export interface AddBackgroundOptions {
  origin: [number, number, number];
  size?: [number, number];
  scale: [number, number, number];
  // 对象欧拉角（**弧度**，scene.json 的 angles；缺省 [0,0,0]）。three 的 Object3D 变换顺序
  // 正是 T·R·S，所以 mesh.rotation 直接承载它。
  angles?: [number, number, number];
  // WE 图像颜色混合模式（缺省 0）。非 0 且**已实现**（6/7/31）时改用预乘 ShaderMaterial
  // + CustomBlending 复刻 WE 的 ApplyBlending；0 或未实现的模式 → 维持普通 alpha 混合。
  colorBlendMode?: number;
  texture?: THREE.Texture;
  alpha?: number;
  brightness?: number;
  // v0.8.2 F2：util 层无 pkg 纹理，按 layerKind 用内置材质（solid 纯色 / 其余直通占位）。
  util?: UtilLayerKind;
  // 对象颜色（0-255）：image tint 乘进内容材质（F13）；util=solid 作纯色。
  color?: [number, number, number];
  // color 来自 `{user|script,value}` 绑定（WE 运行期动态驱动；我们只有静态默认值）：
  // colorBlendMode ≠ 0 时跳过 tint，保留内容原色（见 addBackground 的调制注释）。
  colorUserBound?: boolean;
  // 对象 alignment（WE 9 值）：origin 是锚点，内容 mesh / 合成 quad 中心按锚点偏移（F13）。
  alignment?: string;
  sceneW: number;
  sceneH: number;
  // scene.json 的**对象 id**（脚本图层桥的键）：本字段**总是传**（非隔离对象也要能被脚本按
  // 对象 id 找到），与只在隔离时传的 isolate.objectId 区分。
  objectId?: number;
  // 时间线世界变换的锚点 origin（缺省 = origin）。text 的 origin 已含 anchorOffset，这里传
  // 未偏移的对象原点是给 updateBackgroundTransform 回推偏移用；image/util 不传。
  transformOrigin?: [number, number, number];
  // 唯一绘制序（= scene.json objects 数组下标，对齐 WE `m_objectsByRenderOrder`：lwe CScene.cpp:94-101）。
  // 缺省 0（背景在粒子之前绘制）。
  renderOrder?: number;
  // 对象隔离（对象级效果链）：五字段把三种量分开——objectId、rtWidth/rtHeight、worldW/worldH。
  isolate?: { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number };
  // 对象级视差深度（scene.json 的 parallaxDepth，两根轴）；缺省 undefined = 不参与视差。
  parallaxDepth?: [number, number];
  // 视差节点原点（WE 场景坐标）：父链锚点继承时 = 锚点对象世界 origin（子层与父层同一位移）；
  // 缺省 = 自身 origin。语义见 client/parallax-contract.ts。
  parallaxNodeOrigin?: [number, number, number];
  // 动态 color 禁用（text 图层）：静态色已烘进纹理，脚本/时间线 color 不再乘材质（AGENT §7.44）。
  disableDynamicColor?: boolean;
}

export interface AddPuppetOptions {
  objectId: number;
  puppet: PuppetInstance;
  origin: [number, number, number];
  scale: [number, number, number];
  // 对象欧拉角（**弧度**，scene.json 的 angles；与 addBackground 同口径）。
  angles: [number, number, number];
  sceneW: number;
  sceneH: number;
  // 唯一绘制序（= scene.json objects 数组下标）；缺省 0（背景在粒子之前绘制）。
  renderOrder?: number;
  // 对象级 alpha/brightness（同 addBackground，缺省 1/1 = 不改材质）；走 materialModulation 烘进 puppet 材质。
  alpha?: number;
  brightness?: number;
  // 对象级视差深度（同 addBackground）；缺省 undefined = 不参与视差。
  parallaxDepth?: [number, number];
  // 视差节点原点（同 addBackground）：父链锚点继承时 = 锚点对象世界 origin。
  parallaxNodeOrigin?: [number, number, number];
  // scene.json 的 `animationlayers`（T8）：undefined = 字段缺失（逐帧退回「播动画表首个」）。
  animationLayers?: SceneImageObject['animationLayers'];
  // 对象贴图（= 建 puppet 材质时的 map）：效果链在**贴图空间**跑，隔离内容就是这张贴图的平面。
  texture?: THREE.Texture | null;
  // 对象隔离（对象级效果链）：字段与 addBackground 的 isolate 相同（见其注释）。
  isolate?: { objectId: number; rtWidth: number; rtHeight: number; worldW: number; worldH: number };
}

// 背景图层装配（image / util / text 共用）。隔离对象的内容材质不套 cb（forIsolation），
// 混合语义交给合成 quad（见 layer-material-factory 注释）。
export function addBackground(host: BackgroundAssemblyHost, opts: AddBackgroundOptions): number {
  const sceneW = opts.sceneW;
  const sceneH = opts.sceneH;
  // util 的 project/fullscreen = 全屏层：WE 语义铺满视口，强制居中 + 场景尺寸（忽略对象 origin/scale/size）。
  // 2597392171 #54 三者全缺省 ⇒ 原实现把合成 quad 放在场景左下四分之一。
  const utilFull = opts.util === 'project' || opts.util === 'fullscreen';
  const origin: [number, number, number] = utilFull
    ? [sceneW / 2, sceneH / 2, 0]
    : [opts.origin[0], opts.origin[1], opts.origin[2]];
  // 时间线世界变换以对象锚点为基准：text 的 origin 含 anchorOffset，回推成渲染偏移保存。
  const anchorOrigin = opts.transformOrigin ?? origin;
  const renderOffset: [number, number, number] = utilFull ? [0, 0, 0] : [
    origin[0] - anchorOrigin[0], origin[1] - anchorOrigin[1], origin[2] - anchorOrigin[2],
  ];
  const layerScale: [number, number, number] = utilFull
    ? [1, 1, 1]
    : [opts.scale[0], opts.scale[1], opts.scale[2]];
  const size = utilFull ? ([sceneW, sceneH] as [number, number]) : opts.size;
  // 背景尺寸 = size × scale（geometry 未缩放、mesh.scale 承载 scale）；size 缺省回退纹理宽高。
  // 精灵表（材质声明 spritesheet）回退**单帧**宽高；有 TEXS 但未声明的仍按整表尺寸（旧语义）。
  // util 无纹理：compose/solid 缺 size 时按 1×1（与 utilWorldSize 同口径）。
  const sprite = opts.util
    ? undefined
    : (opts.texture?.userData?.spritesheet === true ? textureSpriteInfo(opts.texture) : undefined);
  const imgW = opts.texture?.image?.width as number | undefined;
  const imgH = opts.texture?.image?.height as number | undefined;
  const fallbackW = opts.util ? (utilFull ? sceneW : 1) : (sprite ? (imgW ?? 1) / sprite.cols : (imgW ?? 1));
  const fallbackH = opts.util ? (utilFull ? sceneH : 1) : (sprite ? (imgH ?? 1) / sprite.rows : (imgH ?? 1));
  const w = size?.[0] ?? fallbackW;
  const h = size?.[1] ?? fallbackH;
  const geometry = new THREE.PlaneGeometry(w, h);
  // 内容材质调制：image 的 color tint × brightness 与 alpha 一次烘进（隔离路径同样烘进 RT；
  // 合成 quad 保持中性，见 createCompositeQuadMaterial）。
  // 参考引擎 WPSceneParser：image 内容材质的 g_Color4/g_Color/g_Alpha/g_Brightness 恒取作者值，
  // 追加混合 pass 的 B = **已带 tint 的内容** ⇒ cb≠0 也要烘 tint（否则云/前景雾比桌面亮）。
  // 例外：`{user,value}` 绑定的 color 在 WE 由脚本/属性动态驱动，我们只有静态默认值 ⇒ 保留旧行为
  //（不 tint，内容原色），见 2832263418 音频条（AGENT §7.40 ⑯）。
  const mod = materialModulation(
    opts.colorBlendMode && opts.colorUserBound ? undefined : opts.color,
    opts.alpha,
    opts.brightness,
  );
  // ⚠️ 隔离对象（opts.isolate）走 forIsolation=true：内容材质**不套** cb，混合语义全部交给
  // 合成 quad（见 createLayerMaterial / createCompositeQuadMaterial 注释）。
  const material = opts.util
    ? createUtilLayerMaterial(
      resolveUtilMaterial(opts.util, { color: opts.color, alpha: opts.alpha }),
      !!opts.isolate,
      opts.brightness,
    )
    : createLayerMaterial(opts.texture ?? null, opts.colorBlendMode ?? 0, mod, !!opts.isolate);
  const mesh = new THREE.Mesh(geometry, material);
  // text 图层的静态色已烘进 canvas；打标让 applyLayerState 跳过脚本/时间线 color（否则文字被二次乘暗）。
  if (opts.disableDynamicColor) material.userData.dynamicColorDisabled = true;
  // 脚本 color 覆盖对象 color 时，applyLayerState 需要重新乘上对象 brightness（装配期已烘进材质）。
  mesh.userData.weBrightness = opts.brightness ?? 1;
  // renderOrder 唯一化（调用方按 objects 下标传入）；缺省 0 = 背景在粒子之前绘制（背景在下）。
  mesh.renderOrder = opts.renderOrder ?? 0;
  const s = layerScale;
  mesh.scale.set(s[0], s[1], s[2]);
  // 对象角度（弧度）：PlaneGeometry 以几何中心为 pivot，mesh.rotation 即 T·R·S 的 R。
  const a = opts.angles ?? [0, 0, 0];
  mesh.rotation.set(a[0], a[1], a[2]);
  // alignment：origin 是锚点，中心 = origin + 偏移（偏移先乘 scale、再随 angles 旋转）。
  const align = alignmentWorldOffset([w, h], s, a, opts.alignment);
  // we_to_three：origin - scene/2（y 不翻）。
  mesh.position.set(
    origin[0] - sceneW / 2 + align[0],
    origin[1] - sceneH / 2 + align[1],
    origin[2],
  );

  // 图层 id（= backgroundEntries 的键）由本类计数器分配；隔离条目的键是
  // **scene.json 的对象 id**（`opts.isolate.objectId`），两套编号互不相干（见 attachIsolated）。
  const id = host.nextBackgroundId();
  // 世界尺寸（未钳制幅值）：隔离路径下作合成 quad 的几何尺寸（缩放已并入几何，quad 自身
  // scale 恒为 1）；优先用调用方传入的 worldW/worldH，缺省回退 |size × scale|。
  const worldW = opts.isolate?.worldW ?? Math.abs(w * s[0]);
  const worldH = opts.isolate?.worldH ?? Math.abs(h * s[1]);

  if (opts.isolate) {
    // 隔离：内容只保留 scale（含镜像），位移/旋转交给合成 quad 承载；colorBlendMode 落在
    // 「贴回画面」这一步。键 = scene.json 的对象 id（**不是**图层计数器 id）。
    mesh.position.set(0, 0, 0);
    mesh.rotation.set(0, 0, 0);
    // util 的 alpha 作用在合成输出：内容占位透明、效果链输出自带 alpha ⇒ 只能在 quad 上收口。
    const compositeOpacity = opts.util ? mod.a : 1;
    host.attachIsolated(
      opts.isolate.objectId, 'background', mesh, worldW, worldH,
      { width: opts.isolate.rtWidth, height: opts.isolate.rtHeight },
      { x: origin[0] - sceneW / 2 + align[0], y: origin[1] - sceneH / 2 + align[1], z: origin[2] },
      [a[0], a[1], a[2]], opts.colorBlendMode ?? 0, opts.renderOrder, compositeOpacity,
    );
    // 隔离时 displayObject 返回合成 quad：标记也要落到它的材质上，否则脚本 color 仍会乘到合成输出。
    if (opts.disableDynamicColor) {
      const quadMat = (host.isolatedQuad(opts.isolate.objectId) as THREE.Mesh | undefined)?.material;
      const mats = Array.isArray(quadMat) ? quadMat : quadMat ? [quadMat] : [];
      for (const m of mats) m.userData.dynamicColorDisabled = true;
    }
    // util 层内容输入（T3）：段边界把整帧快照写成内容。solid 的内容是纯色 ⇒ 不建条目。
    if (opts.util && opts.util !== 'solid') {
      host.registerUtilContent(opts.isolate.objectId, mesh, origin[0] - sceneW / 2, origin[1] - sceneH / 2);
    }
  } else {
    host.scene.add(mesh);
  }

  host.addEntry(id, {
    mesh,
    origin: [origin[0], origin[1], origin[2]],
    size: [w, h],
    scale: [s[0], s[1], s[2]],
    angles: [a[0], a[1], a[2]],
    align,
    alignment: opts.alignment,
    color: opts.color,
    alpha: mod.a,
    brightness: opts.brightness ?? 1,
    sceneW,
    sceneH,
    renderOffset,
    // 隔离时位移的载体是合成 quad（内容只进对象 RT）；attachIsolated 在本方法之前登记 quad。
    parallaxNode: opts.isolate ? (host.isolatedQuad(opts.isolate.objectId) ?? mesh) : mesh,
    parallaxDepth: opts.parallaxDepth,
    parallaxNodeOrigin: opts.parallaxNodeOrigin,
  });
  // scene 对象 id → 显示对象（隔离时是合成 quad —— 内容 mesh 只渲染进对象 RT，不进主场景）。
  if (opts.objectId !== undefined) {
    host.setObjectToBackground(opts.objectId, id);
    const shown = opts.isolate ? host.isolatedQuad(opts.isolate.objectId) : mesh;
    if (shown) host.setDisplayObject(opts.objectId, shown);
  }
  // 精灵表：纹理带 spritesheet 标记 + TEXS 帧网格 ⇒ 逐帧接管 quad UV（缺任一条件保持整图）。
  if (opts.objectId !== undefined && sprite && opts.texture?.userData?.spritesheet === true) {
    host.registerSpriteSheet(id, opts.objectId, mesh, sprite);
  }
  return id;
}

// puppet 图层：SkinnedMesh（带骨骼）或静态网格 + 视差登记。返回图层 id（与 addBackground 同一编号空间）。
// 几何/材质所有权在 PuppetInstance（dispose 时释放）；此处只把 mesh 挂进场景并登记视差/脚本桥。
export function addPuppet(host: BackgroundAssemblyHost, opts: AddPuppetOptions): number {
  const { mesh } = opts.puppet;
  mesh.renderOrder = opts.renderOrder ?? 0;
  // 对象级调制：与背景同一份公式（MeshBasicMaterial → color 乘亮度、opacity 取 alpha）；缺省 1/1 即原样。
  const mod = materialModulation(undefined, opts.alpha, opts.brightness);
  const mat = mesh.material as THREE.MeshBasicMaterial;
  mat.color.setRGB(mod.r, mod.g, mod.b);
  mat.opacity = mod.a;
  const s = opts.scale;
  mesh.scale.set(s[0], s[1], s[2]);
  mesh.rotation.set(opts.angles[0], opts.angles[1], opts.angles[2]);
  // we_to_three：origin - scene/2（y 不翻，见 AGENT.md §2.3）。
  mesh.position.set(opts.origin[0] - opts.sceneW / 2, opts.origin[1] - opts.sceneH / 2, opts.origin[2]);
  host.scene.add(mesh);
  // 对象级效果链（WE 语义：链路在**贴图空间**合成，输出当 puppet 贴图；webwallgl drawPuppetDirect
  // 的 overrideTex 同口径）。内容 = 对象贴图的平面，尺寸取对象世界尺寸（aspect 与贴图一致）。
  // ⚠️ 内容 quad **不要** flipGeometryUvY：y 镜像局部相机 + 标准 THREE uv + 显示约定贴图 ⇒ RT
  // v=0=图像顶部（WE 约定），与图片对象/效果 mask（topDown 加载）同一套坐标；再翻一次会让
  // mask 在 v 方向整体镜像（波动落到错误部位，或 mask 全 0 直接失效）。输出同样 WE 约定，
  // 由 setObjectOutput 在采样处翻回显示约定。
  if (opts.isolate) {
    const iso = opts.isolate;
    const w = Math.max(1, Math.abs(iso.worldW));
    const h = Math.max(1, Math.abs(iso.worldH));
    const contentGeometry = new THREE.PlaneGeometry(w, h);
    const content = new THREE.Mesh(
      contentGeometry,
      new THREE.MeshBasicMaterial({ map: opts.texture ?? null, transparent: true, side: THREE.DoubleSide }),
    );
    host.attachIsolated(
      iso.objectId, 'puppet', content, w, h,
      { width: iso.rtWidth, height: iso.rtHeight },
      { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
      [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      0, opts.renderOrder, 1,
      // 合成 quad 不挂主场景（输出直接当网格贴图）；puppet 实例交给 setObjectOutput 写 map。
      false, opts.puppet,
    );
  }
  const id = host.nextBackgroundId();
  // 复用背景条目：视差逐帧写位、player.dispose 释放几何/材质、脚本层桥都走同一条路径。
  // （同一条目会被两条释放路径各 dispose 一次 —— three 的 dispose 幂等。）
  host.addEntry(id, {
    mesh,
    origin: [opts.origin[0], opts.origin[1], opts.origin[2]],
    size: [0, 0],
    scale: [s[0], s[1], s[2]],
    angles: [opts.angles[0], opts.angles[1], opts.angles[2]],
    align: [0, 0], // puppet 网格无 alignment 样本（F13 只覆盖 image quad；真实库 puppet 均为 center/缺省）
    alpha: mod.a,
    brightness: opts.brightness ?? 1,
    sceneW: opts.sceneW,
    sceneH: opts.sceneH,
    renderOffset: [0, 0, 0],
    parallaxNode: mesh,
    parallaxDepth: opts.parallaxDepth,
    parallaxNodeOrigin: opts.parallaxNodeOrigin,
  });
  // 动画层：字段缺失记 null（逐帧区分「无元数据」与「显式无可见层」），存在则先按 visible 过滤。
  host.setPuppetLayer(id, {
    instance: opts.puppet,
    layers: opts.animationLayers === undefined
      ? null
      : opts.animationLayers.filter((l) => l.visible !== false),
    elapsed: 0,
  });
  // scene 对象 id → 显示对象（脚本 layer.visible/alpha 的落点，与 addBackground 同语义）。
  host.setDisplayObject(opts.objectId, mesh);
  host.setObjectToBackground(opts.objectId, id);
  return id;
}
