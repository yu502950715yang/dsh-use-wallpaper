import * as THREE from 'three';
import type { GlowStage } from './glow-stage.js';
import type { FrameCapture } from './frame-capture.js';
import type { ClockDriver } from './text-object.js';
import type { ParallaxConfig, PointerState } from './parallax.js';
import type { PuppetInstance } from './puppet.js';
import type { SceneImageObject, UtilLayerKind } from '../shared/types.js';
export declare const DEFAULT_PARTICLE_CAPACITY = 1024;
export declare const MAX_PARTICLE_CAPACITY = 2048;
export declare const PARTICLE_FLOATS_PER_INSTANCE = 16;
export declare function specMaxcount(specJson: string): number;
export interface ParticleRendererSpec {
    kind: 'sprite' | 'spritetrail';
    length: number;
    maxLength: number;
    minLength: number;
}
export declare function specRenderer(specJson: string): ParticleRendererSpec;
export declare function textureTexelRatio(tex?: THREE.Texture): number;
export declare function specPerspective(specJson: string): boolean;
export declare function specSparseEventSource(specJson: string): boolean;
export declare function particlePerspectiveCamera(opts: {
    fov: number;
    perspectiveOverrideFov: number;
    sceneH: number;
}): {
    fov: number;
    distance: number;
};
export declare function specEmitterOrigin(specJson: string): [number, number, number];
export declare const BLACKMYTH_OBJ_SCALE: [number, number, number];
export declare function simEmitterOffset(emitterOrigin: [number, number, number]): [number, number, number];
export declare function particleCapacity(declaredMax: number, aliveAtCreate: number): number;
/** WE `colorBlendMode` → three `CustomBlending` 设置；未实现的模式返回 null。 */
export declare function colorBlendModeToThree(mode: number): {
    blendEquation: THREE.BlendingEquation;
    blendSrc: THREE.BlendingSrcFactor | THREE.BlendingDstFactor;
    blendDst: THREE.BlendingDstFactor;
} | null;
export interface IsolatedObject {
    /** 键 = scene.json 的**对象 id**（不是本类图层的计数器 id，见 attachIsolated 注释）。 */
    id: number;
    kind: 'background' | 'particle';
    rt: THREE.WebGLRenderTarget;
    rtWidth: number;
    rtHeight: number;
    rtTexture: THREE.Texture;
    localScene: THREE.Scene;
    localCamera: THREE.OrthographicCamera;
    quad: THREE.Mesh;
    /** 合成 quad 的世界尺寸（= |对象 size/dist × scale|，未钳制幅值），resize 重建几何时用。 */
    worldW: number;
    worldH: number;
}
export interface ObjectEffectStage {
    bindOutputs(): void;
    advance(time: number): void;
    /** 段边界（消费者被绘制**之前**）同步通知：本帧快照 + 捕获当刻代号（语义见 object-effects.ts）。 */
    onSegmentBoundary?(objectId: number, frameTexture?: THREE.Texture | null, snapshotVersion?: number): void;
    /** 段边界快照同步（`_rt_FullFrameBuffer` 槽门控用；只有 allowFrameSnapshot 放行的链才绑它）。 */
    setFrameSnapshot?(frameTexture: THREE.Texture | null): void;
    /** 画布缓冲/视口变化：作废尚未被 advance 消费的在途快照（resize 会重建快照纹理）。 */
    notifyViewportResize?(): void;
}
export interface UtilContentCover {
    sx: number;
    sy: number;
    sw: number;
    sh: number;
}
export declare function resolvePixelRatio(devicePixelRatio: number, qualityScale: number): number;
export declare class ThreeScenePlayer {
    readonly renderer: THREE.WebGLRenderer;
    readonly scene: THREE.Scene;
    readonly camera: THREE.OrthographicCamera;
    readonly canvas: HTMLCanvasElement;
    private sceneWidth;
    private sceneHeight;
    private viewWidth;
    private lastDpr;
    private viewHeight;
    private pixelRatio;
    private qualityScale;
    private clearColorValue;
    private paused;
    private pausedAt;
    private pausedTotal;
    private loopFn;
    private pendingCapture;
    private lastTime;
    private parallaxCfg;
    private parallaxTarget;
    private parallaxFollow;
    private backgroundEntries;
    private nextBackgroundId;
    private readonly spritesheetLayers;
    private puppetLayers;
    private particleLayers;
    private nextParticleLayerId;
    private readonly displayObjects;
    private isolated;
    private readonly utilContents;
    private lastFrameSnapshot;
    private objectEffectStage;
    private glowStage;
    private bloomStage;
    private bloomRT;
    private frameCapture;
    private readonly frameConsumers;
    private readonly refractLayers;
    private refractHidden;
    private readonly warnedConsumers;
    private compositeQuad;
    private readonly startedAt;
    constructor(canvas: HTMLCanvasElement, width: number, height: number, renderer?: THREE.WebGLRenderer, qualityScale?: number, opts?: {
        clearColor?: [number, number, number];
    });
    resize(width: number, height: number): void;
    private ensureBloomRT;
    /** 画质档位：走 resize 路径重推画布缓冲与屏幕密度（对象 RT 的基准随之变化）。 */
    setQualityScale(scale: number): void;
    /** 暂停帧循环（省电）：停 RAF 排程；暂停时长不计入 elapsedSeconds。 */
    pause(): void;
    /** 恢复帧循环（暂停期间的时间被扣除，恢复后 g_Time 不跳变）。 */
    resume(): void;
    isPaused(): boolean;
    private devicePixelRatio;
    private nowMs;
    setSceneSize(width: number, height: number): void;
    screenScalePx(): number;
    private applyCover;
    update(dt: number): void;
    private tickPuppets;
    private registerSpriteSheet;
    private applySpriteSheetFrame;
    private updateSpriteSheets;
    pauseSpriteSheet(objectId: number): void;
    playSpriteSheet(objectId: number): void;
    /** 停播并回到第 0 帧（对齐 AnimPlayback.stop 的语义）。 */
    stopSpriteSheet(objectId: number): void;
    isSpriteSheetPlaying(objectId: number): boolean;
    /** 立即写 UV（越界钳到 [0, frames-1]）；同时把 elapsed 对齐到该帧，play 后从这里继续。 */
    setSpriteSheetFrame(objectId: number, frame: number): void;
    getSpriteSheetFrame(objectId: number): number;
    /** 测试用：取精灵表图层当前帧的 UV 子矩形（仅测试/诊断观测，不参与渲染）。 */
    spritesheetUvForTest(objectId: number): {
        u0: number;
        v0: number;
        u1: number;
        v1: number;
    } | null;
    /** 相机视差配置（null = 未启用/已拆除 ⇒ 逐帧零成本早退；enabled=false 时下一帧把对象写回基准位置）。 */
    setParallax(cfg: ParallaxConfig | null): void;
    /** 宿主指针监听的最新归一化位置（[0,1]）；插值在本类的 tickParallax 内按 dt 推进。 */
    setParallaxPointer(p: PointerState): void;
    /** 测试用：取某背景条目的 three 对象（隔离对象返回合成 quad）。 */
    backgroundMeshForTest(id: number): THREE.Object3D;
    /** 测试用：直接推进一帧视差。 */
    tickParallaxForTest(dt: number): void;
    private tickParallax;
    setAnimationLoop(fn?: (dt: number) => void): void;
    private installLoop;
    render(): void;
    /**
     * 请求抓取**下一帧**渲染结果（PNG 字节；首帧缓存用）。已有未决请求时返回 null（一帧只抓一张）。
     * 必须在 render() 同一任务内读像素，故这里只登记请求、由 render() 末尾同步读取。
     */
    captureNextFrame(): Promise<Uint8Array | null>;
    private flushCapture;
    /** 注入帧内快照（null = 关闭）。契约见 frame-capture.ts；active=false 时帧序不变。 */
    setFrameCapture(capture: FrameCapture | null): void;
    /** 登记一个「需要帧内快照」的消费者（键 = scene.json 对象 id）：它开启新的一段，快照拍在它**之前**。 */
    registerFrameConsumer(objectId: number): void;
    private checkFrameConsumers;
    private hideRefractWithoutCapture;
    /**
     * 段渲染：按 renderOrder 升序把主场景顶层对象切成若干段（消费者**开启**新的一段，段数 = 消费者数 + 1），
     * 逐段渲染进 frameCapture.target（段间 autoClear=false 累积），消费者段的快照拍在该段 render **之前**，
     * 末段合成回默认 fb。WE 对齐点：lwe CScene.cpp:351-361 按 m_objectsByRenderOrder 逐个 render()；
     * REFRACT 在画该层**前** blit 场景 FBO（CParticle.cpp:2069-2079）。
     */
    private renderSegmented;
    setObjectEffectStage(stage: ObjectEffectStage | null): void;
    /** 装配应用级 Glow（null = 关闭）。关闭时帧序与本方法加入前逐字相同。 */
    setGlowStage(stage: GlowStage | null): void;
    /** 装配壁纸级 bloom（null = 关闭）。关闭时帧序与本方法加入前逐字相同。 */
    setBloomStage(stage: GlowStage | null): void;
    /** 按 scene.json 对象 id 取最终显示的 three 对象（脚本图层桥用）。未登记 → undefined。 */
    displayObject(objectId: number): THREE.Object3D | undefined;
    isolatedObjects(): IsolatedObject[];
    setObjectOutput(id: number, texture: THREE.Texture): void;
    setUtilContentTexture(objectId: number, texture: THREE.Texture, opts?: {
        cover?: UtilContentCover;
    }): void;
    /** 测试/诊断：util 内容当前纹理；solid / 非 util → null。 */
    utilContentTextureForTest(objectId: number): THREE.Texture | null;
    /** 测试/诊断：util 内容当前的快照覆盖矩形（内容 mesh UV 空间）。 */
    utilContentUvForTest(objectId: number): UtilContentCover | null;
    /** 最近一次段边界快照（渲染器每帧同步给 ObjectEffectStage 的 `_rt_FullFrameBuffer` 槽门控）。 */
    currentFrameSnapshot(): THREE.Texture | null;
    private registerUtilContent;
    private utilContentCoverFor;
    private applyUtilContentCover;
    private renderUtilContent;
    captureFullFrame(): THREE.Texture | null;
    frameSnapshotVersion(): number;
    resizeObjectRT(id: number, width: number, height: number): void;
    private renderIsolatedContents;
    elapsedSeconds(): number;
    addBackground(opts: {
        origin: [number, number, number];
        size?: [number, number];
        scale: [number, number, number];
        angles?: [number, number, number];
        colorBlendMode?: number;
        texture?: THREE.Texture;
        alpha?: number;
        brightness?: number;
        util?: UtilLayerKind;
        color?: [number, number, number];
        sceneW: number;
        sceneH: number;
        objectId?: number;
        renderOrder?: number;
        isolate?: {
            objectId: number;
            rtWidth: number;
            rtHeight: number;
            worldW: number;
            worldH: number;
        };
        parallaxDepth?: [number, number];
    }): number;
    addPuppet(opts: {
        objectId: number;
        puppet: PuppetInstance;
        origin: [number, number, number];
        scale: [number, number, number];
        angles: [number, number, number];
        sceneW: number;
        sceneH: number;
        renderOrder?: number;
        alpha?: number;
        brightness?: number;
        parallaxDepth?: [number, number];
        animationLayers?: SceneImageObject['animationLayers'];
    }): number;
    private createLayerMaterial;
    private createUtilLayerMaterial;
    private createCompositeQuadMaterial;
    private applyCompositeSampling;
    private attachIsolated;
    update_background(id: number, origin?: [number, number, number], scale?: [number, number, number], alpha?: number, brightness?: number): void;
    resizeBackground(id: number, size: [number, number]): void;
    addParticle(simVerticesGetter: () => Float32Array, opts: {
        tex?: THREE.Texture;
        frameCount: number;
        frameCols?: number;
        frameRows?: number;
        blend: 'additive' | 'alpha';
        softness?: number;
        objectCenter?: [number, number, number];
        objectScale?: [number, number, number];
        objectAngles?: [number, number, number];
        emitterOrigin?: [number, number, number];
        maxInstances?: number;
        trail?: {
            length: number;
            maxLength: number;
            minLength: number;
        };
        perspective?: {
            fov: number;
            distance: number;
            aspect: number;
        };
        refract?: {
            normalTex: THREE.Texture;
            amount: number;
        };
        objectId?: number;
        renderOrder?: number;
        isolate?: {
            objectId: number;
            rtWidth: number;
            rtHeight: number;
            worldW: number;
            worldH: number;
        };
        parallaxDepth?: [number, number];
    }): number;
    updateParticles(dt: number): void;
    private writeParticleData;
    dispose(): void;
}
export interface ParticleSim {
    update(dt: number): void;
    vertices(): Float32Array;
    frame_count(): number;
    set_frame_count(n: number): void;
    particle_count(): number;
    free?(): void;
}
export interface LoadedParticleAssets {
    specJson: string;
    tex?: THREE.Texture;
    blend: 'additive' | 'alpha';
    softness?: number;
    overrideJson?: string;
    refract?: {
        normalTex: THREE.Texture;
        amount: number;
    };
}
export type ParticleSimFactory = (json: string, origin: [number, number, number], sceneW: number, sceneH: number, overrideJson: string) => ParticleSim;
export interface SceneAssets {
    renderer?: THREE.WebGLRenderer;
    backgroundTextures?: Map<number, THREE.Texture>;
    puppetMeshes?: Map<number, PuppetInstance>;
    particles?: Map<number, LoadedParticleAssets>;
    createParticleSim?: ParticleSimFactory;
    isolate?: Map<number, {
        objectId: number;
        rtWidth: number;
        rtHeight: number;
        worldW: number;
        worldH: number;
    }>;
    worldTransforms?: Map<number, {
        origin: [number, number, number];
        scale: [number, number, number];
        angles: [number, number, number];
    }>;
    qualityScale?: number;
    textLayers?: Map<number, {
        texture: THREE.Texture;
        driver?: ClockDriver;
        size?: [number, number];
        anchorOffset?: [number, number];
    }>;
    onFrame?: (dt: number) => void;
}
export interface ThreeSceneLoadResult {
    player: ThreeScenePlayer;
    sims: ParticleSim[];
    backgroundIds: number[];
    puppetLayers: number[];
    particleLayers: Array<{
        id: number;
        sim: ParticleSim;
    }>;
}
export declare function frameCountFromDims(width: number, height: number): number;
export declare function textureFrameCount(tex?: THREE.Texture): number;
export declare function textureSpriteInfo(tex?: THREE.Texture): {
    frames: number;
    cols: number;
    rows: number;
} | undefined;
export declare function textureFrameGrid(tex?: THREE.Texture): {
    cols: number;
    rows: number;
};
export declare function loadSceneToThree(sceneJson: string, assets: SceneAssets, canvas: HTMLCanvasElement, viewport?: {
    width: number;
    height: number;
}): ThreeSceneLoadResult;
