/** 宿主 → shim 的消息契约（`__wpPointer` 是版本化的命名空间标记，避免误吃页面的其它消息）。 */
export declare const POINTER_MESSAGE_TAG = "__wpPointer";
/**
 * 待注入 shim：patch addEventListener 记住 mouse 类监听，收宿主坐标后**直接调用**该 handler
 * （不经真实 DOM 派发 —— pointer-events:none 下正是不存在可派发目标才需要它）。
 * 覆盖三种目标（window / document / 任意元素）与三种 handler 形态（函数 / handleEvent 对象 /
 * 数组，jQuery 2.x 手写时传数组寻址），并保持 removeEventListener 真实可摘。
 */
export declare const POINTER_SHIM_SOURCE = "(function(){\n  var w=window;\n  if(w.__wpPointerShimInstalled) return;\n  w.__wpPointerShimInstalled=true;\n  var Ctor=w.EventTarget||w.Node;\n  if(!Ctor||!Ctor.prototype) return;\n  var proto=Ctor.prototype;\n  var origAdd=proto.addEventListener;\n  var origRemove=proto.removeEventListener;\n  var slots=0, tgt=null, type='', handler=null, opts=null, entry=null;\n  var isMouse=function(t){ return typeof t==='string'&&t.indexOf('mouse')===0; };\n  proto.addEventListener=function(t,fn,o){\n    // \u5355\u4E2A handler \u4E0D\u80FD\u91CD\u590D\u88C5\uFF0C\u6545\u8BB0\u5F55=\u66FF\u6362\uFF1B\u540C handler \u91CD\u6302\u5F53\u4F5C\u5DF2\u88C5\uFF08entry \u4FDD\u6301\u6709\u6548\uFF09\u3002\n    if(isMouse(t)&&fn!=null){\n      slots+=1;\n      var same=(handler===fn&&tgt===this&&type===t);\n      tgt=this; type=t; handler=fn; opts=o;\n      if(!same) entry=null;\n    }\n    return origAdd.apply(this,arguments);\n  };\n  proto.removeEventListener=function(t,fn,o){\n    if(isMouse(t)&&fn!=null&&tgt===this&&type===t&&handler===fn){ tgt=null; handler=null; entry=null; }\n    return origRemove.apply(this,arguments);\n  };\n  var detailFn=function(e){ return handler.handleEvent(e); };\n  var pick=function(){\n    if(entry) return entry;\n    if(handler==null) return null;\n    if(typeof handler==='function') entry=handler;\n    else if(typeof handler.handleEvent==='function') entry=detailFn;\n    else if(handler.length>0&&typeof handler[0]==='function') entry=handler[0];\n    return entry;\n  };\n  var fire=function(t,x,y){\n    var fn=pick();\n    if(!fn||tgt==null) return;\n    var E=w.MouseEvent;\n    if(!E) return;\n    var e=new E(t,{bubbles:false,cancelable:true,view:w,clientX:x,clientY:y,screenX:x,screenY:y});\n    try{\n      if(fn===detailFn) detailFn(e); else fn.call(tgt,e);\n      w.__wpPointerHits=(w.__wpPointerHits||0)+1;\n    }catch(err){}\n  };\n  w.addEventListener('message',function(ev){\n    var d=ev&&ev.data;\n    if(!d||d.__wpPointer!==1) return;\n    var sx=w.innerWidth||0, sy=w.innerHeight||0;\n    if(!(sx>0)||!(sy>0)) return;\n    var x=Number(d.px), y=Number(d.py);\n    if(!(x>=0&&x<=sx)) x=Number(d.nx)*sx;\n    if(!(y>=0&&y<=sy)) y=Number(d.ny)*sy;\n    if(!isFinite(x)||!isFinite(y)) return;\n    fire('mousemove',x,y);\n  });\n})();";
/**
 * 把 shim 源码包成可内联的 `<script>`：转义 `</script` 与 `<!--`（HTML 脚本元素里这两处会提前
 * 终止/进入注释态）。本源码自身不含模板字面量，故不涉及 `${` 逃逸。
 */
export declare function escapeShimForInlineScript(source?: string): string;
/**
 * HTML 注入：优先插在 `<head>` 开标签之后（壁纸自带脚本一律在 head 之后执行）；无 `<head>` 时插在
 * `<html>` 之后，仍无则前置到文档开头。找不到任何锚点时返回 null（调用方保留原文，绝不改坏响应）。
 */
export declare function injectPointerShim(html: string, script?: string): string | null;
