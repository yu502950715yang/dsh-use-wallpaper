// @vitest-environment jsdom
// web 壁纸「跟随鼠标」直传：host 注入的 shim + 宿主 postMessage 的端到端判据。
// 夹具用**真实** jquery.parallax.min.js（本机工坊 1184182304 的 js/，只读；不复制进仓库），
// 缺素材即跳过 —— 与仓库既有「本机素材」用例同一口径。
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import {
  POINTER_SHIM_SOURCE,
  escapeShimForInlineScript,
  injectPointerShim,
} from '../src/shared/pointer-shim.js';

const WE_WORKSHOP = process.env.WE_WORKSHOP ?? 'D:/Steam/steamapps/workshop/content/431960';
const EVA5 = join(WE_WORKSHOP, '1184182304', 'js');
const JQUERY_SRC = join(EVA5, 'jquery-2.1.1.min.js');
const PARALLAX_SRC = join(EVA5, 'jquery.parallax.min.js');
const haveRealLib = existsSync(JQUERY_SRC) && existsSync(PARALLAX_SRC);

const SHIM = escapeShimForInlineScript(POINTER_SHIM_SOURCE);
const RAF_POLYFILL =
  '<script>window.__raf=[];window.requestAnimationFrame=function(cb){window.__raf.push(cb);return window.__raf.length};' +
  'window.cancelAnimationFrame=function(){}</script>';
// rAF 只按需手动 flush（先派发 mousemove 再跑帧），避免库的递归 rAF 在 jsdom 里空转。
const FLUSH_RAF = 'while(window.__raf.length){var q=window.__raf.shift();q(performance.now&&performance.now()||Date.now());window.__rafFlushes=(window.__rafFlushes||0)+1;if(window.__rafFlushes>200)break;}';

const SCENE_HTML = '<ul id="scene">' +
  [0.2, 0.4, 0.6, 0.8, 0.9].map((d) => `<li class="layer" data-depth="${d}"><div class="layerbox"></div></li>`).join('') +
  '</ul>';

interface Fixture {
  dom: JSDOM;
  win: any;
  /** 等 jQuery ready 回调真正跑完（parallax 实例建立）。 */
  ready(): Promise<void>;
  /** 一次宿主 → 帧的指针直传 + 跑一帧（模拟 pointermove → postMessage → rAF）。 */
  moveTo(nx: number, ny: number): Promise<void>;
  transforms(): string[];
  /** 数值化位移（%）：比较语义而非字符串格式（库的空位移写作 `translate3d(0,0,0)` 或 `0%`）。 */
  offsets(): number[];
}

function loadFixture(opts: { shim: boolean }): Fixture {
  const html = '<!doctype html><html><head>' + RAF_POLYFILL + (opts.shim ? SHIM : '') + '</head>' +
    '<body>' + SCENE_HTML + '</body></html>';
  const dom = new JSDOM(html, { runScripts: 'dangerously' });
  const win = dom.window as any;
  // 库必须在 body 存在后再执行：jquery.parallax 的 `transformSupport('3D')` 会
  // `document.body.appendChild(...)`，在 <head> 里执行时 body 尚为 null ⇒ 抛错、`$.fn.parallax`
  // 从不挂上（夹具加载顺序问题，与插件无关）。故把加载脚本挂到 body 之后。
  if (haveRealLib) {
    const s = win.document.createElement('script');
    s.textContent =
      `window.eval(${JSON.stringify(readFileSync(JQUERY_SRC, 'utf8'))});` +
      `window.eval(${JSON.stringify(readFileSync(PARALLAX_SRC, 'utf8'))});` +
      "window.__libOk=(typeof $==='function')&&(typeof $.fn.parallax==='function');" +
      "$(document).ready(function(){$('#scene').parallax();});";
    win.document.body.appendChild(s);
  }
  // 库在 initialise() 里把视口尺寸读成 ww/wh（jsdom 无布局）；钉成固定视口让映射可预期。
  win.innerWidth = 1280;
  win.innerHeight = 720;
  return {
    dom,
    win,
    // jsdom 的 postMessage 派发是**异步任务**，必须先让出宏任务再跑帧，否则帧里读到的仍是旧 ix/iy。
    async moveTo(nx: number, ny: number) {
      win.postMessage({ __wpPointer: 1, nx, ny, px: -1, py: -1 }, '*');
      await new Promise((r) => setTimeout(r, 0));
      win.eval(FLUSH_RAF);
    },
    transforms: () => [...win.document.querySelectorAll('.layer')].map((el: any) => el.style.transform),
    offsets: () => [...win.document.querySelectorAll('.layer')].map((el: any) => {
      const m = /translate3d\((-?[\d.]+)(?:%|px)?,\s*(-?[\d.]+)/.exec(el.style.transform ?? '');
      return m ? Math.abs(parseFloat(m[1])) : 0;
    }),
    ready: async () => {
      // jQuery 的 ready 回调经 setTimeout 派发（jsdom 无真实加载事件），故让出宏任务再断言；
      // 未就绪时直接失败并给出可读原因，避免下游出现难懂的「transform 为空」。
      for (let i = 0; i < 10 && !win.eval("!!(window.$&&$('#scene')&&$('#scene').data('api'))"); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      if (haveRealLib) expect(win.__libOk, 'jquery.parallax 未挂到 $.fn 上').toBe(true);
      expect(win.eval("!!$('#scene').data('api')"), 'parallax 实例未建立（ready 回调没跑？）').toBe(true);
    },
  };
}

describe('pointer-shim 注入工具', () => {
  it('把 shim 包成内联 script，并转义会提前终止脚本的序列', () => {
    const s = escapeShimForInlineScript('var a=1; // </script> <!--');
    expect(s.startsWith('<script>')).toBe(true);
    expect(s.endsWith('</script>')).toBe(true);
    // 正文里不得再出现裸露的 </script / <!--
    const body = s.slice('<script>'.length, -'</script>'.length);
    expect(body).not.toContain('</script');
    expect(body).not.toContain('<!--');
  });

  it('插在 <head> 之后（壁纸自带脚本之前），找不到 head 时退回 <html> 之后', () => {
    const out = injectPointerShim('<html><head><title>t</title><script src="a.js"></script></head><body></body></html>', '<script>S</script>');
    expect(out).not.toBeNull();
    const at = out!.indexOf('<script>S</script>');
    expect(at).toBeGreaterThan(out!.indexOf('<head>'));
    expect(at).toBeLessThan(out!.indexOf('a.js'));

    const noHead = injectPointerShim('<html><body><p>x</p></body></html>', '<script>S</script>');
    expect(noHead!.indexOf('<script>S</script>')).toBeLessThan(noHead!.indexOf('<p>'));
  });

  it('无任何可用锚点时返回 null（调用方保留原响应，不破坏输出）', () => {
    expect(injectPointerShim('just text', '<script>S</script>')).toBeNull();
  });
});

describe('shim 运行时行为（合成范围与坐标映射）', () => {
  // 契约：shim 只保留**最后一个** mouse 类监听（单个 handler 无法重复注册，记多个也无从同时调用）。
  // 真实用法（jquery.parallax 等）只挂一个 window.mousemove，正落在这个契约内；下面逐项钉住。
  function run(extra: string) {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'dangerously' });
    const win = dom.window as any;
    // 视口必须在装 shim 之前钉好：shim 的 message 处理器会读 innerWidth/Height 做坐标换算。
    win.innerWidth = 1280;
    win.innerHeight = 720;
    win.eval(POINTER_SHIM_SOURCE);
    win.eval(extra);
    return { win, dom };
  }

  // shim 的 message 回调是宏任务：必须让出一次再断言。
  const post = async (win: any, data: unknown) => {
    win.postMessage(data, '*');
    await new Promise((r) => setTimeout(r, 0));
  };

  it('window 上注册的 mousemove 会被触发（真实库的用法）', async () => {
    const { win, dom } = run('window.__seen=[];window.addEventListener("mousemove",function(e){window.__seen.push([e.type,e.clientX,e.clientY]);});');
    await post(win, { __wpPointer: 1, nx: 0.5, ny: 0.25, px: -1, py: -1 });
    expect(win.__seen).toEqual([['mousemove', 640, 180]]);
    dom.window.close();
  });

  it('document 上注册的 mousemove 同样会被触发（不限 window）', async () => {
    const { win, dom } = run('document.__seen=[];document.addEventListener("mousemove",function(e){document.__seen.push([e.clientX,e.clientY]);});');
    await post(win, { __wpPointer: 1, nx: 0.25, ny: 0.5, px: -1, py: -1 });
    expect(win.document.__seen).toEqual([[320, 360]]);
    dom.window.close();
  });

  it('px/py 在视口内时优先使用；越界/缺失时按 nx/ny × iframe 视口换算', async () => {
    const { win, dom } = run('window.__seen=[];window.addEventListener("mousemove",function(e){window.__seen.push([e.clientX,e.clientY]);});');
    await post(win, { __wpPointer: 1, nx: 0.5, ny: 0.25, px: 320, py: 180 });
    expect(win.__seen[0]).toEqual([320, 180]);

    await post(win, { __wpPointer: 1, nx: 0.5, ny: 0.25, px: -1, py: -1 });
    expect(win.__seen[1]).toEqual([640, 180]); // 0.5×1280 / 0.25×720
    dom.window.close();
  });

  it('只合成 mouse 类事件：非 mousemove 监听与异名消息都不触发', async () => {
    const { win, dom } = run('window.__seen=[];window.__wheel=0;' +
      'window.addEventListener("mousemove",function(e){window.__seen.push(e.type);});' +
      'window.addEventListener("wheel",function(){window.__wheel++;});');
    await post(win, { __wpPointer: 1, nx: 0.5, ny: 0.5, px: -1, py: -1 });
    await post(win, { someOtherMessage: true, nx: 1, ny: 1 });
    await post(win, { __wpPointer: 0, nx: 1, ny: 1 }); // 版本标记不为 1：忽略
    await post(win, null);
    expect(win.__wheel).toBe(0);
    expect(win.__seen).toEqual(['mousemove']);
    dom.window.close();
  });

  it('消息不带有效数字时不触发（畸形输入不炸也不乱动）', async () => {
    const { win, dom } = run('window.__seen=[];window.addEventListener("mousemove",function(){window.__seen.push(1);});');
    await post(win, { __wpPointer: 1, nx: 'x', ny: null });
    await post(win, { __wpPointer: 1, nx: NaN, ny: 0.5 });
    expect(win.__seen).toHaveLength(0);
    dom.window.close();
  });
});

describe.skipIf(!haveRealLib)('真实 jquery.parallax 壁纸（1184182304）', () => {
  it('夹具自检：真实库挂上了 $.fn.parallax（否则下面三条判据都无意义）', async () => {
    const f = loadFixture({ shim: false });
    await f.ready();
    expect(f.win.__libOk).toBe(true);
    f.dom.window.close();
  });

  it('【对照】不注入 shim：pointer-events:none 下鼠标进不来，图层恒在零点', async () => {
    const f = loadFixture({ shim: false });
    await f.ready();
    // 该墙纸把 mousemove 绑在自己的 window 上：把事件真的派发进去也只能证明「派发才有用」，
    // 而 pointer-events:none 的 iframe 永远收不到 —— 这里正是复刻「什么都不发生」的现状。
    expect(f.offsets()).toEqual([0, 0, 0, 0, 0]);
    await f.moveTo(0.9, 0.2); // 没装 shim ⇒ postMessage 无人理
    expect(f.offsets()).toEqual([0, 0, 0, 0, 0]);
    // 库确实在跳帧（api 存在、transform 每帧被写），却没有位移 —— 「库在跑、但拿不到鼠标」的现状签名。
    expect(f.win.eval("!!$('#scene').data('api')")).toBe(true);
    expect(f.transforms()[0]).toMatch(/^translate3d\(0/); // 每帧都在写，值恒 0
    await f.moveTo(0.1, 0.9);
    expect(f.offsets()).toEqual([0, 0, 0, 0, 0]);
    f.dom.window.close();
  });

  it('【修复判据】注入 shim 后一次坐标直传即让图层脱离零点（= 脱离 pointer-events:none 的封锁）', async () => {
    const f = loadFixture({ shim: true });
    await f.ready();
    await f.moveTo(1, 0); // 右上角：ix=1 / iy=-1
    const px = f.offsets();
    expect(px.some((v) => v > 0)).toBe(true);
    // 深度越大位移越大（jquery.parallax：mx = ix × scalarX，逐层 × depth）
    expect(px[4]).toBeGreaterThan(px[0]);
    f.dom.window.close();
  });

  it('【跟随性】连续两个不同坐标产生不同位移', async () => {
    const f = loadFixture({ shim: true });
    await f.ready();
    await f.moveTo(1, 0);
    const a = f.transforms();
    await f.moveTo(0, 1);
    const b = f.transforms();
    expect(b).not.toEqual(a);
    // 换坐标后 x 轴位移确实变了（不只是格式差异）
    expect(f.offsets()[0]).not.toEqual(expect.closeTo(0, 5));
    f.dom.window.close();
  });

  it('【反脆弱】patch 不改变 removeEventListener 语义：摘掉监听后不再触发', () => {
    const html = '<!doctype html><html><head>' + RAF_POLYFILL + SHIM +
      '<script>window.hits=0;function onMove(){window.hits++;}' +
      'window.addEventListener("mousemove",onMove);window.removeEventListener("mousemove",onMove);</script>' +
      '</head><body></body></html>';
    const dom = new JSDOM(html, { runScripts: 'dangerously' });
    const win = dom.window as any;
    win.innerWidth = 1280;
    win.innerHeight = 720;
    win.postMessage({ __wpPointer: 1, nx: 0.5, ny: 0.5, px: -1, py: -1 }, '*');
    expect(win.hits).toBe(0);
    dom.window.close();
  });
});
