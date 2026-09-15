// WE 视频纹理（flags bit5 = Video）的 DOM 侧行为：mp4 载荷 → THREE.VideoTexture，
// 以及**资源生命周期**（`<video>` + Blob URL 不受 GPU 资源释放管，必须在纹理 dispose 时清理）。
//
// 真实样本：2911105183 的 `materials/CP_ads_01/02.tex` —— ftyp isom/iso2/avc1/mp41、H.264、
// 1280×720、27.4s、无音轨。jsdom 不会真解码，所以这里用 FakeVideo 精确控制
// `loadeddata` / `error` 时机与监听器，断言的是**我们的**行为（判定走哪条分支、纹理属性、
// dispose 时停播 + 撤销 URL），不是浏览器的解码能力（那由 research/tmp-2911105183/probe-video-play.mjs 实测）。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as THREE from 'three';
import { parseTex, textureFromTex, isVideoTexPayload, TEX_FORMAT } from '../../src/client/tex-loader.js';
import { makeTex } from '../fixtures/make-tex.js';

/** 完整 mp4 头（size + 'ftyp' + 品牌）——判定只看这个 box。 */
const MP4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]);

/** 可控的假 `<video>`：只实现我们与 three 的 VideoTexture 真正触碰的接口。 */
class FakeVideo {
  muted = false;
  loop = false;
  playsInline = false;
  preload = '';
  src = '';
  readyState = 0;
  videoWidth = 1280;
  videoHeight = 720;
  private listeners = new Map<string, Set<() => void>>();
  play = vi.fn(async () => {});
  pause = vi.fn();
  remove = vi.fn();
  load = vi.fn();
  removeAttribute = vi.fn();
  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  has(type: string): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }
  dispatch(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}

const videoTex = (data = MP4, flags = 32) => parseTex(makeTex({
  flags, container: 'TEXB0003', imageFormat: -1, format: TEX_FORMAT.RGBA8888,
  images: [[{ width: 1280, height: 720, data }]],
}))!;

describe('textureFromTex 视频纹理（flags bit5 = Video）', () => {
  let videos: FakeVideo[];
  const createObjectURL = vi.fn(() => 'blob:test-mp4');
  const revokeObjectURL = vi.fn();
  let realCreateElement: typeof document.createElement;

  beforeEach(() => {
    videos = [];
    realCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: unknown) => {
      if (tag === 'video') {
        const v = new FakeVideo();
        videos.push(v);
        return v as unknown as HTMLElement;
      }
      return (realCreateElement as (t: string, o?: unknown) => HTMLElement)(tag, opts);
    }) as typeof document.createElement);
    // jsdom 不实现 Blob URL
    (URL as unknown as Record<string, unknown>).createObjectURL = createObjectURL;
    (URL as unknown as Record<string, unknown>).revokeObjectURL = revokeObjectURL;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (URL as unknown as Record<string, unknown>).createObjectURL;
    delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
  });

  /** 等到实现注册了某个事件监听（避免用固定 sleep 猜时序）。 */
  async function waitForListener(v: FakeVideo, type: string): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (v.has(type)) return;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error(`实现没有注册 ${type} 监听`);
  }

  it('mp4 载荷 + loadeddata → THREE.VideoTexture，且 muted/loop/playsInline 与自动播放已设置', async () => {
    const info = videoTex();
    expect(isVideoTexPayload(info)).toBe(true);
    const p = textureFromTex(info);
    await waitForListener(videos[0], 'loadeddata');
    videos[0].dispatch('loadeddata');
    const tex = await p;

    expect(tex).toBeInstanceOf(THREE.VideoTexture);
    expect(tex!.image).toBe(videos[0]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect((createObjectURL.mock.calls[0][0] as Blob).type).toBe('video/mp4');
    // 静音 + 内联播放是「无手势自动播放」的前提
    expect(videos[0].muted).toBe(true);
    expect(videos[0].loop).toBe(true);
    expect(videos[0].playsInline).toBe(true);
    expect(videos[0].play).toHaveBeenCalled();
    // 视频不进 mip 链（每帧 needsUpdate 会每帧重建 mip）
    expect(tex!.minFilter).toBe(THREE.LinearFilter);
    expect(tex!.generateMipmaps).toBe(false);
  });

  it('显示约定（缺省）flipY=true；效果槽约定（rowOrder:topDown）flipY=false', async () => {
    const p1 = textureFromTex(videoTex());
    await waitForListener(videos[0], 'loadeddata');
    videos[0].dispatch('loadeddata');
    expect((await p1)!.flipY).toBe(true);

    videos = [];
    const p2 = textureFromTex(videoTex(), { rowOrder: 'topDown' });
    await waitForListener(videos[0], 'loadeddata');
    videos[0].dispatch('loadeddata');
    expect((await p2)!.flipY).toBe(false);
  });

  it('wrap 语义沿用 flags（bit1 clampuvs → ClampToEdge，否则 REPEAT）+ fxRes 带上视频尺寸', async () => {
    const p1 = textureFromTex(videoTex(MP4, 32 | 2));
    await waitForListener(videos[0], 'loadeddata');
    videos[0].dispatch('loadeddata');
    const clamped = (await p1)!;
    expect(clamped.wrapS).toBe(THREE.ClampToEdgeWrapping);

    videos = [];
    const p2 = textureFromTex(videoTex(MP4, 32));
    await waitForListener(videos[0], 'loadeddata');
    videos[0].dispatch('loadeddata');
    const repeat = (await p2)!;
    expect(repeat.wrapS).toBe(THREE.RepeatWrapping);
    expect((repeat.userData as { fxRes?: number[] }).fxRes).toEqual([1280, 720, 1280, 720]);
  });

  it('dispose 时停播 + 撤销 Blob URL（GPU 资源释放兜不住解码中的 <video>）', async () => {
    const p = textureFromTex(videoTex());
    await waitForListener(videos[0], 'loadeddata');
    videos[0].dispatch('loadeddata');
    const tex = (await p)!;
    expect(revokeObjectURL).not.toHaveBeenCalled();

    tex.dispose();
    expect(videos[0].pause).toHaveBeenCalled();
    expect(videos[0].src).toBe('');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-mp4');
  });

  it('播放失败（error 事件）→ 清理 + 返回 1×1 透明纹理（不白板、不当像素解码乱码）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = textureFromTex(videoTex());
    await waitForListener(videos[0], 'error');
    videos[0].dispatch('error');
    const tex = await p;
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(tex!.image.width).toBe(1);
    expect(tex!.image.height).toBe(1);
    // 透明像素（map 为空会让对象变成**白色不透明**面板，乱码解码会画出噪声）
    expect(Array.from((tex!.image as { data: Uint8Array }).data)).toEqual([0, 0, 0, 0]);
    expect(videos[0].pause).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-mp4');
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('视频纹理');
  });

  it('flags 带 Video 位但载荷不是 mp4 → 根本不建 <video>（回落原始像素路径）', async () => {
    const rgba = new Uint8Array(8 * 8 * 4).fill(0x40);
    const info = parseTex(makeTex({
      flags: 32, container: 'TEXB0003', imageFormat: -1, format: TEX_FORMAT.RGBA8888,
      images: [[{ width: 8, height: 8, data: rgba }]],
    }))!;
    const tex = await textureFromTex(info);
    expect(tex).toBeInstanceOf(THREE.DataTexture);
    expect(tex!.image.width).toBe(8);
    expect(videos).toHaveLength(0);
  });
});
