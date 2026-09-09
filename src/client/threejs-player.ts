// Task 1：three.js 场景骨架（renderer + 正交相机 cover + RAF 循环）。
// 这是「WE 场景 → three.js 播放器」思路的第一步：先把播放器骨架搭好，后续 Task 2/3/4
// 往里加背景 Sprite 与粒子。
//
// 坐标 / cover 语义复用 scene-renderer.ts（不重写，避免双份语义漂移）：
//   - coverRange(sceneW, sceneH, viewAspect)：把场景固有尺寸（WE 正交视口 view_w×view_h）
//     按视口宽高比做 cover 裁剪（铺满、不变形、超出方向裁掉），得到正交相机视锥尺寸
//     view_w/view_h。构造传入的 width/height 是场景固有尺寸（scene.json 未就绪前的冗余值）；
//     视口缺省与场景同尺寸，此时 cover == contain == 场景尺寸（无裁剪）。
//   - CAMERA_DISTANCE：相机沿 +z 放置，使 shader 里 300/-mv.z = 1（点尺寸=像素尺寸）。
//   - 正交相机 y 轴不做翻转（WE 系左下原点 y 向上与 three 正交相机一致，见 scene-renderer
//     文件头坐标注释；背景/粒子用同一相机，保持 cover 与 we_to_three 语义）。
import * as THREE from 'three';
import { coverRange, CAMERA_DISTANCE } from './scene-renderer.js';

export class ThreeScenePlayer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.OrthographicCamera;

  // 场景固有尺寸（WE 正交视口 view_w×view_h；scene.json 未就绪前用构造传入值，越过后
  // 用 setSceneSize 更新）与当前视口尺寸（canvas 逻辑像素）。
  private sceneWidth: number;
  private sceneHeight: number;
  private viewWidth: number;
  private viewHeight: number;

  private lastTime = 0;

  constructor(
    canvas: HTMLCanvasElement,
    width: number,
    height: number,
    // 可选注入 renderer：node/jsdom 无 WebGL 无法构造真 WebGLRenderer，测试用 mock 注入
    // （契约「可 mock renderer」）。缺省创建标准 antialias WebGLRenderer。
    renderer?: THREE.WebGLRenderer,
  ) {
    this.sceneWidth = width;
    this.sceneHeight = height;
    // 视口缺省与场景同尺寸 → cover == 场景尺寸（无裁剪）。resize(w,h) 后按视口裁剪。
    this.viewWidth = width;
    this.viewHeight = height;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    this.camera.position.z = CAMERA_DISTANCE;

    this.renderer = renderer ?? new THREE.WebGLRenderer({ canvas, antialias: true });
    this.applyCover();
    this.renderer.setSize(width, height, false);
  }

  // 视口尺寸变更（浏览器 resize / controller 设置 canvas 逻辑尺寸）：只改视口，重新按
  // cover 推导相机范围（cover 语义保持，裁剪方向随视口宽高比变化，不固定传 w/h）。
  resize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.applyCover();
    this.renderer.setSize(width, height, false);
  }

  // 场景固有尺寸（scene.json 的 general.orthogonalprojection）就绪后设置，同时重推 cover。
  // 构造传入的 width/height 只是缺省冗余值（「缺省用传入 width/height」）。
  setSceneSize(width: number, height: number): void {
    this.sceneWidth = width;
    this.sceneHeight = height;
    this.applyCover();
  }

  // 按 cover 语义把相机视锥设为场景尺寸的 cover 视图（中心原点，z 范围 -1000..1000 不变）。
  private applyCover(): void {
    const viewAspect = this.viewWidth / this.viewHeight;
    const fg = coverRange(this.sceneWidth, this.sceneHeight, viewAspect);
    this.camera.left = -fg.w / 2;
    this.camera.right = fg.w / 2;
    this.camera.top = fg.h / 2;
    this.camera.bottom = -fg.h / 2;
    this.camera.updateProjectionMatrix();
  }

  // 每帧扩展钩子：Task 1 空实现，后续 Task 2/3/4 在这里挂背景 Sprite 更新 / 粒子模拟。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  update(_dt: number): void {}

  // 启动帧循环（renderer.setAnimationLoop 内部 RAF）。每帧：update(dt)（内部钩子）→
  // 可选外部回调 fn(dt) → render(scene, camera)。dt 用 performance.now 差分，clamp 0.1s
  // 防 tab 切后台 / RAF 停顿后 dt 过大把粒子瞬移出视口（同 wasm-renderer 语义）。
  setAnimationLoop(fn?: (dt: number) => void): void {
    this.lastTime = performance.now();
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const dt = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      this.update(dt);
      fn?.(dt);
      this.renderer.render(this.scene, this.camera);
    });
  }

  // 手动渲染一帧（不依赖 RAF，供测试/调用方直接触发）。
  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  // 停止循环并释放 renderer 资源。
  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
  }
}
