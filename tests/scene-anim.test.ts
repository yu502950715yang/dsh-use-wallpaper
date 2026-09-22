import { describe, it, expect } from 'vitest';
import { extractAnimFps, AnimRegistry } from '../src/client/scene-anim.js';

// fps 是逐动画的：同一张壁纸 loops[].fps=60 而 paperTimelines[].fps=1200（相差 20 倍）。
// scene.pkg 内无动画数据，唯一来源是脚本内嵌 config 的 "name":…,"fps":N 文本。

describe('extractAnimFps', () => {
  it('从 loops/paperTimelines 形态提取 name → fps', () => {
    const src = `const config={"loops":[{"id":10750,"property":"alpha","name":"loop_kv2_line__10750_alpha","clip":"loop_kv2_line","duration":8.73,"fps":60}],
      "paperTimelines":[{"id":1122,"property":"origin","name":"信封_root_1_origin","clip":"act53side_trans_kv1tokv2","duration":2.1667,"fps":1200}]};`;
    const t = extractAnimFps(src);
    expect(t.get('loop_kv2_line__10750_alpha')).toBe(60);
    expect(t.get('信封_root_1_origin')).toBe(1200);
  });

  it('无 fps 字段的源码返回空表（不抛错）', () => {
    expect(extractAnimFps('export function update(v){return v;}').size).toBe(0);
  });

  it('忽略非法 fps（0/负数/非有限）', () => {
    const t = extractAnimFps('{"name":"a","fps":0}{"name":"b","fps":-1}');
    expect(t.size).toBe(0);
  });

  it('name 在 fps 之后也能配对（容错顺序）', () => {
    const t = extractAnimFps('{"fps":60,"name":"x"}');
    expect(t.get('x')).toBe(60);
  });

  it('注释里的撇号不吞掉后续配对；字符串里的假 config 不被认领', () => {
    const t = extractAnimFps([
      "// don't break here",
      'var s = \'{"name":"fake","fps":30}\';',
      '{"name":"real","fps":60}',
    ].join('\n'));
    expect(t.get('real')).toBe(60);
    expect(t.has('fake')).toBe(false);
  });
});

// 播放器必须持久（同一 layerKey+name 恒同一对象），否则脚本的 getFrame() 永远返回 0。
describe('AnimRegistry', () => {
  it('同一 (layerKey,name) 返回同一对象（持久性 —— spike 的假阴性根因）', () => {
    const r = new AnimRegistry(new Map());
    expect(r.get('id:1', 'a')).toBe(r.get('id:1', 'a'));
    expect(r.get('id:1', 'a')).not.toBe(r.get('id:2', 'a'));
  });

  it('tick 只推进 playing 的播放器，速率 = 该动画 fps', () => {
    const r = new AnimRegistry(new Map([['fast', 1200], ['slow', 60]]));
    const fast = r.get('id:1', 'fast');
    const slow = r.get('id:1', 'slow');
    fast.play(); slow.play();
    r.tick(1 / 60);
    expect(fast.getFrame()).toBeCloseTo(20, 5); // 1200 fps → 20 帧/帧
    expect(slow.getFrame()).toBeCloseTo(1, 5); // 60 fps → 1 帧/帧
    slow.pause();
    r.tick(1 / 60);
    expect(slow.getFrame()).toBeCloseTo(1, 5); // 暂停后不推进
    expect(fast.getFrame()).toBeCloseTo(40, 5);
  });

  it('未登记的动画名用 defaultFps 兜底', () => {
    const r = new AnimRegistry(new Map(), 60);
    const a = r.get('id:1', 'unknown');
    a.play(); r.tick(1 / 2);
    expect(a.getFrame()).toBeCloseTo(30, 5);
  });

  it('play/pause/stop/isPlaying 状态正确；stop 归零', () => {
    const r = new AnimRegistry(new Map());
    const a = r.get('id:1', 'x');
    expect(a.isPlaying()).toBe(false);
    a.play(); expect(a.isPlaying()).toBe(true);
    a.setFrame(7); expect(a.getFrame()).toBe(7);
    a.pause(); expect(a.isPlaying()).toBe(false);
    a.stop(); expect(a.getFrame()).toBe(0); expect(a.isPlaying()).toBe(false);
  });

  it('playingCount 反映在播数量', () => {
    const r = new AnimRegistry(new Map());
    r.get('id:1', 'a').play(); r.get('id:1', 'b').play();
    expect(r.playingCount()).toBe(2);
  });
});
