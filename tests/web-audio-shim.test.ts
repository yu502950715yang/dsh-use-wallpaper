// @vitest-environment jsdom
// web 壁纸声音 shim：host 注入（与壁纸同源）+ 宿主 postMessage 下发 ⇒ 控制跨源 iframe 内
// <audio>/<video> 的 muted/volume。边界：只覆盖 HTML media 元素（Web Audio 自建声源控制不到）。
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  WEB_SOUND_MESSAGE_TAG,
  WEB_SOUND_SHIM_SOURCE,
  injectWebShims,
} from '../src/shared/web-audio-shim.js';

/** shim 的 message 回调是宏任务：必须让出一次再断言（与 pointer-shim 测试同口径）。 */
const post = async (win: any, data: unknown) => {
  win.postMessage(data, '*');
  await new Promise((r) => setTimeout(r, 0));
};

function run(html = '<audio id="a"></audio>') {
  const dom = new JSDOM('<!doctype html><html><body>' + html + '</body></html>', { runScripts: 'dangerously' });
  const win = dom.window as any;
  win.eval(WEB_SOUND_SHIM_SOURCE);
  return { win, dom };
}

describe('web-audio-shim 注入工具', () => {
  it('把 pointer 与声音 shim 一起插到 <head> 之后（壁纸自带脚本之前）', () => {
    const out = injectWebShims('<html><head><script src="wallpaper.js"></script></head><body></body></html>');
    expect(out).not.toBeNull();
    expect(out!).toContain(WEB_SOUND_MESSAGE_TAG);
    expect(out!).toContain('__wpPointer');
    const head = out!.indexOf('<head>');
    const firstScript = out!.indexOf('<script>');
    expect(firstScript).toBeGreaterThan(head);
    expect(firstScript).toBeLessThan(out!.indexOf('wallpaper.js'));
  });

  it('无可用锚点返回 null（调用方保留原响应，不破坏输出）', () => {
    expect(injectWebShims('just text')).toBeNull();
  });
});

describe('声音 shim 运行时行为', () => {
  it('收到关闭/开启与音量后作用于页内 media 元素', async () => {
    const { win, dom } = run();
    const audio = win.document.getElementById('a');
    await post(win, { __wpSound: 1, enabled: false, volume: 0.5 });
    expect(audio.muted).toBe(true);
    await post(win, { __wpSound: 1, enabled: true, volume: 0.4 });
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(0.4);
    dom.window.close();
  });

  it('音量越界/缺失时 clamp 到 0-1（默认 1）', async () => {
    const { win, dom } = run();
    const audio = win.document.getElementById('a');
    await post(win, { __wpSound: 1, enabled: true, volume: 2 });
    expect(audio.volume).toBe(1);
    await post(win, { __wpSound: 1, enabled: true });
    expect(audio.volume).toBe(1);
    dom.window.close();
  });

  it('动态创建的媒体元素也被应用（MutationObserver）', async () => {
    const { win, dom } = run('');
    await post(win, { __wpSound: 1, enabled: false, volume: 0.5 });
    const video = win.document.createElement('video');
    win.document.body.appendChild(video);
    await new Promise((r) => setTimeout(r, 0));
    expect(video.muted).toBe(true);
    dom.window.close();
  });

  it('非本协议/畸形消息不影响状态（也不抛）', async () => {
    const { win, dom } = run();
    const audio = win.document.getElementById('a');
    await post(win, { other: true, enabled: false });
    await post(win, null);
    await post(win, { __wpSound: 0, enabled: false });
    expect(audio.muted).toBe(false);
    expect(audio.volume).toBe(1);
    dom.window.close();
  });

  // 真实壁纸（3778198228 等）的页面脚本会自己把 media.muted 写回 false；shim 必须能在
  // 再次播放时兜住宿主的静音状态（play 钩子），否则 web 壁纸在开机动画期间仍会出声。
  it('页面自己改回 muted 后再次播放，仍被 shim 兜住（play 钩子）', async () => {
    const { win, dom } = run();
    const audio = win.document.getElementById('a');
    await post(win, { __wpSound: 1, enabled: false, volume: 0.5 });
    expect(audio.muted).toBe(true);

    audio.muted = false; // 页面脚本（如 updateAudio）把 muted 改回 false
    audio.dispatchEvent(new win.Event('play')); // 再次开始播放（捕获阶段由 shim 处理）
    expect(audio.muted).toBe(true);
    dom.window.close();
  });
});
