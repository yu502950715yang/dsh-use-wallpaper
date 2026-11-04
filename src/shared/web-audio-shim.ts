// 跨源 web 壁纸 iframe 里的「宿主声音设置 → 页内 media 元素」shim 源码（host 注入、宿主 postMessage 下发）。
//
// 为什么需要：web 壁纸在跨源沙箱 iframe 里，宿主拿不到它的 DOM（AGENT.md §5.57）；
// 面板的「壁纸音效」开关/音量只能通过 iframe 内脚本对该页 <audio>/<video> 生效。
// 边界：只控制 HTML media 元素；网页用 Web Audio API 自建的声源控制不到；CSP 禁内联时注入被拦。

import { POINTER_SHIM_SOURCE, escapeShimForInlineScript, injectPointerShim } from './pointer-shim.js';

/** 宿主 → shim 的消息契约（版本化命名空间标记，避免误吃页面其它消息）。 */
export const WEB_SOUND_MESSAGE_TAG = '__wpSound';

/** 收到消息后设置页内所有 audio/video 的 muted / volume；动态插入的媒体元素同样应用。 */
export const WEB_SOUND_SHIM_SOURCE = `(function(){
  var w=window;
  if(w.__wpSoundShimInstalled) return;
  w.__wpSoundShimInstalled=true;
  var state=null;
  var clamp=function(v){ return (typeof v==='number'&&isFinite(v)) ? Math.min(1,Math.max(0,v)) : 1; };
  var apply=function(el){
    if(!state||!el) return;
    if(el.tagName!=='AUDIO'&&el.tagName!=='VIDEO') return;
    try{
      el.muted=!state.enabled;
      if(state.enabled) el.volume=state.volume;
    }catch(err){}
  };
  var applyAll=function(root){
    var host=root||w.document;
    if(!host.querySelectorAll) return;
    var nodes=host.querySelectorAll('audio,video');
    for(var i=0;i<nodes.length;i++) apply(nodes[i]);
  };
  w.addEventListener('message',function(ev){
    var d=ev&&ev.data;
    if(!d||d.${WEB_SOUND_MESSAGE_TAG}!==1) return;
    state={enabled:!!d.enabled,volume:clamp(Number(d.volume))};
    applyAll();
  });
  // 网页播放器常动态建媒体元素：插入 DOM 时应用当前状态。
  var MO=w.MutationObserver;
  if(MO){
    new MO(function(muts){
      if(!state) return;
      for(var i=0;i<muts.length;i++){
        var added=muts[i].addedNodes||[];
        for(var j=0;j<added.length;j++){
          var n=added[j];
          if(!n||n.nodeType!==1) continue;
          apply(n);
          applyAll(n);
        }
      }
    }).observe(w.document.documentElement,{childList:true,subtree:true});
  }
  // 页面脚本可能在收到设置后自己把 muted 写回（如 3778198228 的 updateAudio）：
  // 再次开始播放时重新应用宿主状态（捕获阶段能拿到不冒泡的 play 事件）。
  w.document.addEventListener('play',function(ev){ apply(ev.target); },true);
})();`;

/** 把指针 shim 与声音 shim 一起注入 web 壁纸 HTML（单次插入到 head 开头；无锚点返回 null）。 */
export function injectWebShims(html: string): string | null {
  const script =
    escapeShimForInlineScript(POINTER_SHIM_SOURCE) +
    escapeShimForInlineScript(WEB_SOUND_SHIM_SOURCE);
  return injectPointerShim(html, script);
}
