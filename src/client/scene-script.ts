// src/client/scene-script.ts —— SceneScript 运行时（T3 纯逻辑 + T4 quickjs 绑定层）
// 纯逻辑部分（T3）：与 quickjs 解耦，node 可测 —— buildInitialObjectState 对象状态装配
// 与 normalizeReadback 读回规范化两个纯函数。
// quickjs 绑定层（T4）：SceneScriptRuntime —— 宿主为每个 SceneObject 构造 this 状态对象，
// 绑定到 quickjs 脚本实例，每帧调 update(dt) 并读回 this.image.alpha / origin / scale。
// wasm-renderer 消费此层。MVP 仅处理 image 对象的脚本动画。

import { getQuickJS } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSRuntime, QuickJSHandle } from 'quickjs-emscripten';

export interface ScriptObjectState {
  origin: { x: number; y: number; z: number };
  scale: { x: number; y: number; z: number };
  alpha: number;
  image: { alpha: number; brightness: number };
}

export interface ScriptReadback {
  origin?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  imageAlpha?: number;
  imageBrightness?: number;
}

// 构造 QuickJS 可注入的初始对象状态：origin/scale 由三元组拆成 {x,y,z}，
// image.alpha 复用对象级 alpha，image.brightness 取传入亮度。
export function buildInitialObjectState(
  origin: [number, number, number],
  scale: [number, number, number],
  alpha: number,
  brightness: number,
): ScriptObjectState {
  return {
    origin: { x: origin[0], y: origin[1], z: origin[2] },
    scale: { x: scale[0], y: scale[1], z: scale[2] },
    alpha,
    image: { alpha, brightness },
  };
}

// 规范化读回：clamp alpha 0-1；仅有值字段输出；origin/scale 缺省保留
export function normalizeReadback(raw: {
  origin?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
  imageAlpha?: number;
  imageBrightness?: number;
}): ScriptReadback {
  const rb: ScriptReadback = {};
  if (raw.origin) rb.origin = { x: raw.origin.x, y: raw.origin.y, z: raw.origin.z };
  if (raw.scale) rb.scale = { x: raw.scale.x, y: raw.scale.y, z: raw.scale.z };
  if (raw.imageAlpha !== undefined) rb.imageAlpha = Math.max(0, Math.min(1, raw.imageAlpha));
  if (raw.imageBrightness !== undefined) rb.imageBrightness = raw.imageBrightness;
  return rb;
}

// ============================================================================
// quickjs 绑定层（T4）：SceneScriptRuntime
// 宿主(JS) 为每个 SceneObject 构造一个 this 状态对象（origin/scale/alpha/image 嵌套），
// 绑定到 quickjs 脚本实例，每帧调 update(dt)，宿主读回 this.image.alpha / origin / scale。
// quickjs-emscripten 的 handle 生命周期要点（spike 验证）：
//  - setProp(callFunction) 不消费传入的 value/arg handle，宿主需自行 dispose；
//  - newNumber 等「立即值」handle 即使不 dispose 也不会触发 gc_obj_list 断言，
//    但 newObject / 类实例 / 函数等堆对象的 handle 若不 dispose，runtime.dispose() 会 abort。
// 因此本层对每个堆对象 handle（实例 / 嵌套对象 / 方法函数）都保留引用并在 dispose() 释放。
// ============================================================================

export interface BoundScript {
  update(dt: number): ScriptReadback | null;
}

export class SceneScriptRuntime {
  private ctx: QuickJSContext;
  private runtime: QuickJSRuntime;
  private bounds: Array<{
    instance: QuickJSHandle;
    updateFn: QuickJSHandle;
    thisObj: QuickJSHandle;
    origin: QuickJSHandle;
    scale: QuickJSHandle;
    image: QuickJSHandle;
  }> = [];

  private constructor(ctx: QuickJSContext, runtime: QuickJSRuntime) {
    this.ctx = ctx;
    this.runtime = runtime;
  }

  /** 初始化（异步：quickjs wasm 懒加载）。失败返回 null，调用方退化无动画路径。 */
  static async create(): Promise<SceneScriptRuntime | null> {
    try {
      const QuickJS = await getQuickJS();
      const runtime = QuickJS.newRuntime();
      const ctx = runtime.newContext();
      // 预注册宿主基类 IThisPropertyObject（脚本 class extends 它）
      const base = ctx.evalCode(`
        class IThisPropertyObject { constructor() {} init() {} update(dt) {} }
        globalThis.__IThisPropertyObject = IThisPropertyObject;
        true;
      `);
      if (base.error) {
        base.error.dispose();
        ctx.dispose();
        runtime.dispose();
        return null;
      }
      base.value.dispose();
      return new SceneScriptRuntime(ctx, runtime);
    } catch {
      return null;
    }
  }

  /** 为一个对象绑定脚本。initial 来自 scene.json 解析值。返回 null = 脚本不可用（静态渲染）。 */
  bind(
    script: string,
    initial: {
      origin: [number, number, number];
      scale: [number, number, number];
      alpha: number;
      brightness: number;
    },
  ): BoundScript | null {
    if (!script || typeof script !== 'string') return null;
    const ctx = this.ctx;
    const state = buildInitialObjectState(initial.origin, initial.scale, initial.alpha, initial.brightness);

    // 宿主构造 this 对象（origin/scale/image 嵌套）
    const thisObj = ctx.newObject();
    const originObj = ctx.newObject();
    ctx.setProp(originObj, 'x', ctx.newNumber(state.origin.x));
    ctx.setProp(originObj, 'y', ctx.newNumber(state.origin.y));
    ctx.setProp(originObj, 'z', ctx.newNumber(state.origin.z));
    ctx.setProp(thisObj, 'origin', originObj);
    const scaleObj = ctx.newObject();
    ctx.setProp(scaleObj, 'x', ctx.newNumber(state.scale.x));
    ctx.setProp(scaleObj, 'y', ctx.newNumber(state.scale.y));
    ctx.setProp(scaleObj, 'z', ctx.newNumber(state.scale.z));
    ctx.setProp(thisObj, 'scale', scaleObj);
    const imageObj = ctx.newObject();
    ctx.setProp(imageObj, 'alpha', ctx.newNumber(state.image.alpha));
    ctx.setProp(imageObj, 'brightness', ctx.newNumber(state.image.brightness));
    ctx.setProp(thisObj, 'image', imageObj);
    ctx.setProp(thisObj, 'alpha', ctx.newNumber(state.alpha));

    // 剥掉 export，抓取继承 IThisPropertyObject 的类名，用 `new <Class>()` 实例化。
    const sanitized = script
      .replace(/\bexport\s+class\b/g, 'class')
      .replace(/\bexport\s+default\b/g, '');
    const classMatch = /class\s+([A-Za-z0-9_]+)\s+extends\s+IThisPropertyObject/.exec(sanitized);
    const cname = classMatch ? classMatch[1] : null;

    let instance: QuickJSHandle;
    if (cname) {
      const run = ctx.evalCode(`(function(){ ${sanitized}; return new ${cname}(); })()`);
      if (run.error) {
        run.error.dispose();
        this.disposeObjectGraph(thisObj, originObj, scaleObj, imageObj);
        return null;
      }
      instance = run.value;
    } else {
      // 非 class 形式：包装成对象（bound update 直接调源码函数）
      const run = ctx.evalCode(
        `(function(){ ${sanitized}; return { update: (typeof update === 'function') ? update : (()=>{}) }; })()`,
      );
      if (run.error) {
        run.error.dispose();
        this.disposeObjectGraph(thisObj, originObj, scaleObj, imageObj);
        return null;
      }
      instance = run.value;
    }

    // 装配：把宿主 this 对象的状态注入实例（引擎绑定 this）
    const assign = ctx.evalCode(
      `(function(inst, hostThis){ for (const k of Object.keys(hostThis)) inst[k] = hostThis[k]; return inst; })`,
    );
    if (assign.error) {
      assign.error.dispose();
      instance.dispose();
      this.disposeObjectGraph(thisObj, originObj, scaleObj, imageObj);
      return null;
    }
    const assignFn = assign.value;
    const boundR = ctx.callFunction(assignFn, ctx.undefined, instance, thisObj);
    if (boundR.error) {
      boundR.error.dispose();
      assignFn.dispose();
      instance.dispose();
      this.disposeObjectGraph(thisObj, originObj, scaleObj, imageObj);
      return null;
    }
    boundR.value.dispose();
    assignFn.dispose();

    // 调 init
    const initFn = ctx.getProp(instance, 'init');
    const initR = ctx.callFunction(initFn, instance);
    if (initR.error) {
      initR.error.dispose();
    } else {
      initR.value.dispose();
    }
    initFn.dispose();

    const updateFn = ctx.getProp(instance, 'update');
    // 保留堆对象 handle 供每帧 update 使用，并在 dispose() 时释放，避免 gc_obj_list 断言。
    this.bounds.push({ instance, updateFn, thisObj, origin: originObj, scale: scaleObj, image: imageObj });
    return {
      update: (dt: number): ScriptReadback | null => this.runUpdate(updateFn, instance, dt, thisObj),
    };
  }

  /** 每帧对单个绑定做 update + 读回。脚本抛错返回 null（隔离，不抛给宿主）。 */
  private runUpdate(
    updateFn: QuickJSHandle,
    instance: QuickJSHandle,
    dt: number,
    thisObj: QuickJSHandle,
  ): ScriptReadback | null {
    try {
      const dtHandle = this.ctx.newNumber(dt);
      const r = this.ctx.callFunction(updateFn, instance, dtHandle);
      dtHandle.dispose();
      if (r.error) {
        r.error.dispose();
        return null; // 单对象抛错 → 停动画
      }
      r.value.dispose();

      // 读回 image.alpha / image.brightness（对应脚本 this.image 子对象）
      const image = this.ctx.getProp(thisObj, 'image');
      const imgAlphaH = this.ctx.getProp(image, 'alpha');
      const imageAlpha = this.ctx.getNumber(imgAlphaH);
      imgAlphaH.dispose();
      const imgBrightH = this.ctx.getProp(image, 'brightness');
      const imageBrightness = this.ctx.getNumber(imgBrightH);
      imgBrightH.dispose();
      image.dispose();

      // 读回顶层 origin / scale
      const origin = this.ctx.getProp(thisObj, 'origin');
      const oxH = this.ctx.getProp(origin, 'x');
      const oyH = this.ctx.getProp(origin, 'y');
      const ozH = this.ctx.getProp(origin, 'z');
      const ox = this.ctx.getNumber(oxH);
      const oy = this.ctx.getNumber(oyH);
      const oz = this.ctx.getNumber(ozH);
      oxH.dispose();
      oyH.dispose();
      ozH.dispose();
      origin.dispose();

      const scale = this.ctx.getProp(thisObj, 'scale');
      const sxH = this.ctx.getProp(scale, 'x');
      const syH = this.ctx.getProp(scale, 'y');
      const szH = this.ctx.getProp(scale, 'z');
      const sx = this.ctx.getNumber(sxH);
      const sy = this.ctx.getNumber(syH);
      const sz = this.ctx.getNumber(szH);
      sxH.dispose();
      syH.dispose();
      szH.dispose();
      scale.dispose();

      return normalizeReadback({
        origin: { x: ox, y: oy, z: oz },
        scale: { x: sx, y: sy, z: sz },
        imageAlpha,
        imageBrightness,
      });
    } catch {
      return null;
    }
  }

  /** 对每个绑定调用 update（Task 5 的 wasm-renderer 逐对象调 BoundScript.update，此方法可选）。 */
  tick(dt: number): void {
    for (const b of this.bounds) {
      this.runUpdate(b.updateFn, b.instance, dt, b.thisObj);
    }
  }

  dispose(): void {
    for (const b of this.bounds) {
      b.updateFn.dispose();
      b.instance.dispose();
      b.image.dispose();
      b.scale.dispose();
      b.origin.dispose();
      b.thisObj.dispose();
    }
    this.bounds.length = 0;
    try {
      this.ctx.dispose();
    } catch {
      // noop
    }
    try {
      this.runtime.dispose();
    } catch {
      // gc 断言可忽略
    }
  }

  /** 释放宿主构造的 this 对象图（嵌套 origin/scale/image + thisObj）。 */
  private disposeObjectGraph(
    thisObj: QuickJSHandle,
    origin: QuickJSHandle,
    scale: QuickJSHandle,
    image: QuickJSHandle,
  ): void {
    image.dispose();
    scale.dispose();
    origin.dispose();
    thisObj.dispose();
  }
}
