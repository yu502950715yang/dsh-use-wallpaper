// 跨源 web 壁纸 iframe 里的「宿主指针 → mousemove」shim 源码（host 注入、client 侧同源语义）。
//
// 为什么需要：背景层是 pointer-events:none（styles.ts:3，背景不得吃 GUI 的点击）⇒ 鼠标永远进不了
// 壁纸 iframe，而 web 壁纸普遍把视差绑在**自己 window 的 mousemove** 上（如 jquery.parallax 的
// enable()）⇒ 这类壁纸在插件里恒为静态（AGENT.md §5.48）。
//
// ⚠️ 注入时机：本源码含「非 ASCII 与 < 转义」步骤（escapeShimForInlineScript），必须插在壁纸自带
// 一切脚本**之前**；建 DOM、加元素、运行 __WE_* 脚本都会让整段执行静默丢失。

/** 宿主 → shim 的消息契约（`__wpPointer` 是版本化的命名空间标记，避免误吃页面的其它消息）。 */
export const POINTER_MESSAGE_TAG = '__wpPointer';

/**
 * 待注入 shim：patch addEventListener 记住 mouse 类监听，收宿主坐标后**直接调用**该 handler
 * （不经真实 DOM 派发 —— pointer-events:none 下正是不存在可派发目标才需要它）。
 * 覆盖三种目标（window / document / 任意元素）与三种 handler 形态（函数 / handleEvent 对象 /
 * 数组，jQuery 2.x 手写时传数组寻址），并保持 removeEventListener 真实可摘。
 */
export const POINTER_SHIM_SOURCE = `(function(){
  var w=window;
  if(w.__wpPointerShimInstalled) return;
  w.__wpPointerShimInstalled=true;
  var Ctor=w.EventTarget||w.Node;
  if(!Ctor||!Ctor.prototype) return;
  var proto=Ctor.prototype;
  var origAdd=proto.addEventListener;
  var origRemove=proto.removeEventListener;
  var slots=0, tgt=null, type='', handler=null, opts=null, entry=null;
  var isMouse=function(t){ return typeof t==='string'&&t.indexOf('mouse')===0; };
  proto.addEventListener=function(t,fn,o){
    // 单个 handler 不能重复装，故记录=替换；同 handler 重挂当作已装（entry 保持有效）。
    if(isMouse(t)&&fn!=null){
      slots+=1;
      var same=(handler===fn&&tgt===this&&type===t);
      tgt=this; type=t; handler=fn; opts=o;
      if(!same) entry=null;
    }
    return origAdd.apply(this,arguments);
  };
  proto.removeEventListener=function(t,fn,o){
    if(isMouse(t)&&fn!=null&&tgt===this&&type===t&&handler===fn){ tgt=null; handler=null; entry=null; }
    return origRemove.apply(this,arguments);
  };
  var detailFn=function(e){ return handler.handleEvent(e); };
  var pick=function(){
    if(entry) return entry;
    if(handler==null) return null;
    if(typeof handler==='function') entry=handler;
    else if(typeof handler.handleEvent==='function') entry=detailFn;
    else if(handler.length>0&&typeof handler[0]==='function') entry=handler[0];
    return entry;
  };
  var fire=function(t,x,y){
    var fn=pick();
    if(!fn||tgt==null) return;
    var E=w.MouseEvent;
    if(!E) return;
    var e=new E(t,{bubbles:false,cancelable:true,view:w,clientX:x,clientY:y,screenX:x,screenY:y});
    try{
      if(fn===detailFn) detailFn(e); else fn.call(tgt,e);
      w.__wpPointerHits=(w.__wpPointerHits||0)+1;
    }catch(err){}
  };
  w.addEventListener('message',function(ev){
    var d=ev&&ev.data;
    if(!d||d.${POINTER_MESSAGE_TAG}!==1) return;
    var sx=w.innerWidth||0, sy=w.innerHeight||0;
    if(!(sx>0)||!(sy>0)) return;
    var x=Number(d.px), y=Number(d.py);
    if(!(x>=0&&x<=sx)) x=Number(d.nx)*sx;
    if(!(y>=0&&y<=sy)) y=Number(d.ny)*sy;
    if(!isFinite(x)||!isFinite(y)) return;
    fire('mousemove',x,y);
  });
})();`;

/**
 * 把 shim 源码包成可内联的 `<script>`：转义 `</script` 与 `<!--`（HTML 脚本元素里这两处会提前
 * 终止/进入注释态）。本源码自身不含模板字面量，故不涉及 `${` 逃逸。
 */
export function escapeShimForInlineScript(source: string = POINTER_SHIM_SOURCE): string {
  const body = source.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
  return '<script>' + body + '</script>';
}

/**
 * HTML 注入：优先插在 `<head>` 开标签之后（壁纸自带脚本一律在 head 之后执行）；无 `<head>` 时插在
 * `<html>` 之后，仍无则前置到文档开头。找不到任何锚点时返回 null（调用方保留原文，绝不改坏响应）。
 */
export function injectPointerShim(html: string, script: string = escapeShimForInlineScript()): string | null {
  const lower = html.toLowerCase();
  for (const anchor of ['<head>', '<html>']) {
    const at = lower.indexOf(anchor);
    if (at >= 0) {
      const cut = at + anchor.length;
      return html.slice(0, cut) + script + html.slice(cut);
    }
  }
  if (/<body[\s>]/i.test(html)) return script + html;
  return null;
}
