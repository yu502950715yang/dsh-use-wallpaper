const CSS = `
/* ── 面板设计系统 token（2026-10-30）：派生自 DSH 主题 token，两个设置面板共用 ──
   壁纸面板的旧规则保持不动（tests/styles.test.ts 按旧文本断言契约），统一观感由文件末尾
   「设计系统覆盖」段落地；新组件（tab 栏 / 开机动画面板）直接消费这些变量。 */
:root{
  --we-sp-1:4px;--we-sp-2:8px;--we-sp-3:12px;--we-sp-4:16px;--we-sp-5:24px;
  --we-r-sm:8px;--we-r-md:10px;--we-r-card:14px;--we-r-hero:16px;
  --we-surface:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));
  --we-surface-2:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06));
  --we-border:var(--dsw-alias-border-l2,var(--wp-panel-border));
  --we-border-strong:var(--dsw-alias-border-l1,var(--wp-panel-border));
  --we-shadow-card:0 1px 2px rgba(15,17,22,.04),0 8px 24px rgba(15,17,22,.05);
  --we-shadow-hero:0 10px 26px rgba(15,17,22,.08);
  --we-shadow-pop:0 8px 28px rgba(15,17,22,.18);
  --we-ring:2px solid var(--wp-accent);
  --we-ok:var(--dsw-alias-state-success-primary,#177a3b);
  --we-warn:var(--dsw-alias-state-warning-primary,#b45309);
  --we-danger:var(--dsw-alias-state-error-primary,#b42318);
}
body[data-ds-dark-theme]{
  --we-surface:var(--dsw-alias-bg-layer-3,rgba(28,30,36,.92));
  --we-surface-2:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.14));
  --we-border:var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  --we-border-strong:var(--dsw-alias-border-l1,rgba(255,255,255,.2));
  --we-shadow-card:0 1px 2px rgba(0,0,0,.35),0 10px 28px rgba(0,0,0,.28);
  --we-shadow-hero:0 12px 32px rgba(0,0,0,.42);
  --we-shadow-pop:0 10px 32px rgba(0,0,0,.5);
  --we-ok:#4ade80;--we-warn:#fbbf24;--we-danger:#f87171;
}
/* ── 壁纸层基础（与主题无关） ── */
.wp-background-layer{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.wp-bg-fill{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
.wp-bg-fill img,.wp-bg-fill video,.wp-bg-fill iframe{width:100%;height:100%;object-fit:cover;border:0}
.wp-scene-blur{position:absolute;inset:0;width:100%;height:100%;filter:blur(30px) brightness(.9);transform:scale(1.1)}
.wp-scene-canvas{position:relative;width:100%;height:100%;object-fit:fill}
.wp-bg-fill img{user-select:none}
.wp-kenburns{animation:wp-kenburns 24s ease-in-out infinite alternate}
@keyframes wp-kenburns{from{transform:scale(1) translate(0,0)}to{transform:scale(1.12) translate(-2%,-1%)}}
/* 遮罩：黑色半透明（alpha 内聚于 background，不叠加 opacity 属性；
   浅色主题下同样为深色遮罩，保证文字可读）。既让壁纸背景清晰可见，
   又适度压暗保证文字对比（参考项目 scrim 方案，不做模糊玻璃）。 */
.wp-bg-overlay{position:absolute;inset:0;background:rgba(0,0,0,.3)}

/* ── 插件 UI 主题变量（随 DSH 主题，无壁纸时同样生效） ── */
body:not([data-ds-dark-theme]){
  --wp-panel-bg:rgba(255,255,255,.9);
  --wp-panel-border:rgba(0,0,0,.12);
  --wp-text:#1a1a1e;
  --wp-badge-bg:rgba(0,0,0,.55);
  --wp-badge-fg:#fff;
  --wp-accent:#4f8cff;
  /* 主按钮底色：比 --wp-accent 更深，白字对比度 ≥4.5:1（WCAG AA 小字） */
  --wp-accent-strong:#2563eb;
}
body[data-ds-dark-theme]{
  --wp-panel-bg:rgba(20,22,28,.92);
  --wp-panel-border:rgba(255,255,255,.12);
  --wp-text:#eee;
  --wp-badge-bg:rgba(0,0,0,.65);
  --wp-badge-fg:#fff;
  --wp-accent:#4f8cff;
  --wp-accent-strong:#2563eb;
}

/* ── 壁纸激活层级方案（参考 dsh-liang-skin）：壁纸层 z-index:0 + prepend 到 body 最前；
   仅在有壁纸（body[data-we-wallpaper]）时把 DSH 主内容背景透明化让壁纸透出；
   无壁纸时保持 DSH 原有背景（浅色主题不被破坏）。 */
body[data-we-wallpaper] #root{position:relative;z-index:1;background:transparent!important}
body[data-we-wallpaper] #root [style*="grid-template-columns"]{background:transparent!important}
body[data-we-wallpaper]{background:transparent!important}
body[data-we-wallpaper]{--dsw-alias-bg-base:transparent!important}

/* ── 壁纸背景 token（对照 elysia395/dsh-wallpaper-engine 基础方案，2026-08-21）：
   不做液态玻璃（blur/白底会遮挡背景）——壁纸清晰可见，文字对比靠
   scrim 遮罩压暗 + 文字 token。仅保留边框中性灰（深浅主题下都可见）；侧边栏
   半透明由下方浅/深分支的 --dsw-specific-sidebar-fill 控制（DSH 侧边栏根与列都用它）。 ── */
body[data-we-wallpaper]{
  --dsw-alias-border-l1:rgba(180,180,180,.35);
  --dsw-alias-border-l2:rgba(180,180,180,.35);
  --dsw-alias-border-l2-darkmode-thin:rgba(180,180,180,.35);
}

/* ── 浅色分支：有壁纸 + 非深色主题 ── */
body[data-we-wallpaper]:not([data-ds-dark-theme]){
  /* 浅色主题灰阶按近白底调校，壁纸透出后失去对比 → 压暗整条文字 token（竞品同款） */
  --dsw-alias-label-primary:#000;
  --dsw-alias-label-primary-dimmed:rgb(10,10,12);
  --dsw-alias-label-secondary:rgb(40,42,46);
  --dsw-alias-label-tertiary:rgb(70,73,79);
  --dsw-alias-label-caption:rgb(110,114,120);
  --dsw-alias-label-dimmed:rgb(50,52,56);
  /* 消息区/输入框：壁纸清晰透出，文字靠文字阴影提升对比（不做玻璃遮挡）。
     ⚠ 2026-08-31：--dsw-specific-bubble 不再设 transparent——气泡回 DSH 原生底色
     （深蓝实心，壁纸被气泡遮住，符合"改回原生动泡"）。仅保留消息区 input-major
     transparent 让容器透壁纸，气泡本体用 DSH 默认。 */
  --dsw-specific-input-major:transparent;
  /* --dsw-specific-bubble:transparent;  ← 移除，回 DSH 原生底色 */
  /* 侧边栏：--dsw-specific-sidebar-fill 是 DSH 侧边栏根（hHd-Xa_root）与列的填充色。
     设为半透明白让壁纸透出；!important 覆盖 DSH 主题分支的填充值（原先设 transparent
     覆盖不到 dark 分支，侧边栏仍被不透明底色挡住——2026-08-25 实测定位）。 */
  --dsw-specific-sidebar-fill:rgba(255,255,255,.5)!important;
  /* 弹层菜单底：0.1.7 把它从 var(--dsw-alias-bg-layer-3)（不透明）改成 #f8f9fa94 + blur(40px)
     的玻璃，壁纸透上来后文字发虚 ⇒ 有壁纸时压回接近不透明（浅 .92 / 深 .94）。
     ⚠️ **两个 token 都要覆盖**：0.1.7-rc.2 起公共菜单（命令面板 / 模型选择 / 任务菜单）改由
     MenuSurface 组件读 --dsw-menu-surface-fill 画底，而 --dsw-specific-menu 在非 macOS 上
     退化为它的别名 ⇒ 只覆盖旧 token 对这类菜单无效（2026-09-28 实测 material 底 = rgba(248,249,250,.58)）。 */
  --dsw-specific-menu:rgba(255,255,255,.92)!important;
  --dsw-menu-surface-fill:rgba(255,255,255,.92)!important;
  /* 通知卡片（turn-trigger，「收到任务消息」）与代码块同底：DSH 深色主题给卡片的是
     半透明 hover 色、代码块是实色 —— 页面底被透明化后卡片透壁纸，两块观感不一致
     （AGENT.md §5.42）。hover 同色，避免鼠标移上又透回壁纸。 */
  --dsw-alias-turn-trigger-bg:var(--dsw-alias-markdown-code-block);
  --dsw-alias-turn-trigger-bg-hover:var(--dsw-alias-markdown-code-block);
}
/* 深色分支：气泡回 DSH 原生底色（深蓝实心），壁纸被气泡遮住；仅 message 容器透明。
   同浅色注释：2026-08-31 起 --dsw-specific-bubble 不再设 transparent */
body[data-ds-dark-theme][data-we-wallpaper]{
  --dsw-specific-input-major:transparent;
  /* --dsw-specific-bubble:transparent;  ← 移除，回 DSH 原生底色 */
  /* 深色：侧边栏根填充分支（同浅色注释），暗色半透明让壁纸透出 */
  --dsw-specific-sidebar-fill:rgba(24,26,30,.4)!important;
  /* 弹层菜单底：同浅色分支注释（深色值 #43454a73 α≈.45 同样过透）；**两个 token 都要覆盖** */
  --dsw-specific-menu:rgba(24,26,30,.94)!important;
  --dsw-menu-surface-fill:rgba(24,26,30,.94)!important;
  /* 通知卡片（turn-trigger）与代码块同底：同浅色分支注释（AGENT.md §5.42） */
  --dsw-alias-turn-trigger-bg:var(--dsw-alias-markdown-code-block);
  --dsw-alias-turn-trigger-bg-hover:var(--dsw-alias-markdown-code-block);
}

/* ── 消息气泡（flowItem）回 DSH 原生样式（2026-08-31 决策） ──
   此前插件给[class*="flowItem"]叠加了液态玻璃（blur + 半透明 + 圆角 + 内高光），
   让气泡浮在壁纸上。现按用户要求改回 DSH 原生气泡 —— 移除本覆盖后，气泡使用
   DSH 默认不透明深蓝底色（--dsw-specific-bubble 已在上方分支移除 transparent），
   壁纸会被气泡挡住（原生气泡的正常观感）。
   注意：只移除气泡（flowItem），底部输入框（data-composer-card）与提问弹窗
   （data-question-key）保留插件液态玻璃，不动。 ── */

/* ── 输入框（data-composer-card）与提问弹窗（data-question-key）用「半透明底 + 渐变 + 内阴影」
   表现玻璃感，**刻意不用 backdrop-filter**（2026-10-08）：
   DSH 桌面端在「有壁纸 + 正在输出」时，把鼠标放到「停止」按钮上会出现横向滚动条来回闪现、
   页面样式跳动（关掉壁纸即消失）。二分定位：去掉 backdrop-filter 后完全消失；
   半径从 14px 降到 5px 无效、挪到 ::before 伪元素（无后代，排除 containing block 影响）也无效
   ⇒ 是该属性的**合成层重采样**副作用与 DSH 输入框区域冲突，与强度/层级无关，故直接移除；
   底色不透明度从 .5/.65 提到 .62/.75 补偿失去的模糊。消息气泡（flowItem）已是 DSH 原生。
   ⚠ 本模板字符串内不得出现反引号（会提前终止 CSS 模板）。 ── */
body[data-we-wallpaper] [data-composer-card]{
  border-radius:20px;
  background-color:rgba(255,255,255,.62);
  background-image:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.05) 38%,rgba(255,255,255,.02));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4),inset 0 -1px 0 rgba(255,255,255,.08),0 4px 16px rgba(0,0,0,.1);
}
body[data-ds-dark-theme][data-we-wallpaper] [data-composer-card]{
  background-color:rgba(24,26,30,.75);
  background-image:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02) 38%,rgba(255,255,255,.03));
}
/* 用户提问弹窗（ask_user_question）：其卡片（Mbwy4a_card）原为 transparent，与主输入框
   （data-composer-card）统一视觉（2026-08-25），并同样不用 backdrop-filter（见上方注释）。
   [data-question-key] 是 DSH user-question 组件外层 frame 的稳定属性。 */
body[data-we-wallpaper] [data-question-key] section{
  border-radius:20px;
  background-color:rgba(255,255,255,.62);
  background-image:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.05) 38%,rgba(255,255,255,.02));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4),inset 0 -1px 0 rgba(255,255,255,.08),0 4px 16px rgba(0,0,0,.1);
}
body[data-ds-dark-theme][data-we-wallpaper] [data-question-key] section{
  background-color:rgba(24,26,30,.75);
  background-image:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02) 38%,rgba(255,255,255,.03));
}
/* 侧边栏：背景由 --dsw-specific-sidebar-fill 控制（见上方浅/深分支），此处不再覆盖
   sidebarCol——侧边栏根（hHd-Xa_root）填满该列且用同一 fill，透明后壁纸即透出。
   无 blur（设置对话框 portal 挂在侧边栏下，加 blur 会塌陷）。 */

/* ── 插件 UI 组件（变量驱动，随主题） ── */
.wp-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
.wp-thumb{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;background:transparent;border:1px solid var(--wp-panel-border);border-radius:10px;cursor:pointer;color:var(--wp-text);font:inherit}
.wp-thumb img{width:96px;height:96px;object-fit:cover;border-radius:8px;display:block}
.wp-thumb-title{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wp-thumb.wp-selected{border-color:var(--wp-accent);box-shadow:0 0 0 1px var(--wp-accent)}
.wp-badge{position:absolute;top:2px;right:2px;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;background:var(--wp-badge-bg);color:var(--wp-badge-fg)}

/* ── 设置对话框 "壁纸" 面板（settings-section，用 DSH 主题变量） ──
   信息架构：Hero（当前壁纸）→ 快捷导航 → 常用分组（壁纸库 / 外观 + 播放）→ 高级折叠区。
   控件统一：32px 高、8px 圆角、自定义开关/滑杆/下拉；深/浅色只走 DSH token。 */
.wss-root{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,var(--wp-text));font-size:13px;line-height:1.55;container-type:inline-size;padding-bottom:6px}
/* 分区卡片 */
.wss-section{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));border-radius:14px;padding:14px 16px}
.wss-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}
.wss-section-title{margin:0;font-size:14px;font-weight:650;letter-spacing:.01em;display:flex;align-items:center;gap:8px}
.wss-section-title::before{content:"";width:3px;height:14px;border-radius:2px;background:var(--wp-accent);flex:none}
.wss-section-head .wss-section-title{margin:0}
.wss-section-desc{margin:0 0 10px;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wss-count{font-size:11.5px;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-tertiary,var(--wp-text))}
/* Hero：当前壁纸大预览 + 标题/类型/状态 + 主操作（彩色：蓝紫光斑 + accent 描边，与开机动画 hero 同风格） */
.wss-hero{position:relative;display:flex;align-items:center;gap:16px;padding:14px;border-radius:16px;border:1px solid rgba(79,140,255,.46);background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));box-shadow:0 10px 26px rgba(15,17,22,.08),0 0 0 1px rgba(79,140,255,.10)}
.wss-hero::before{content:"";position:absolute;inset:0;border-radius:inherit;background:radial-gradient(90% 140% at 6% 0%,rgba(79,140,255,.46),transparent 62%),radial-gradient(80% 140% at 100% 100%,rgba(147,51,234,.34),transparent 64%);pointer-events:none}
.wss-hero>*{position:relative;z-index:1}
body[data-ds-dark-theme] .wss-hero{border-color:rgba(96,165,250,.52);background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));box-shadow:0 12px 32px rgba(0,0,0,.35),0 0 0 1px rgba(96,165,250,.14)}
body[data-ds-dark-theme] .wss-hero::before{background:radial-gradient(90% 140% at 6% 0%,rgba(96,165,250,.55),transparent 62%),radial-gradient(80% 140% at 100% 100%,rgba(168,85,247,.42),transparent 64%)}
.wss-hero-media{position:relative;flex:0 0 180px;width:180px;aspect-ratio:16/9;border-radius:12px;overflow:hidden;background:rgba(127,127,127,.14);box-shadow:0 6px 18px rgba(15,17,22,.18),0 0 0 1px rgba(79,140,255,.40)}
.wss-hero-media img{width:100%;height:100%;object-fit:cover;display:block}
.wss-hero-media[data-empty="true"]{display:flex;align-items:center;justify-content:center}
.wss-hero-empty{font-size:12px;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wss-hero-info{display:flex;flex-direction:column;gap:10px;min-width:0;flex:1}
.wss-current{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.wss-current-info{display:flex;flex-direction:column;gap:2px;min-width:0}
.wss-current-label{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--wp-accent)}
.wss-current-name{font-size:17px;font-weight:650;line-height:1.28;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wss-current-actions{display:flex;gap:8px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.wss-hero-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.wss-type-badge{font-size:10px;font-weight:700;letter-spacing:.08em;padding:3px 8px;border-radius:6px;color:#fff;background:linear-gradient(135deg,#4f8cff,#7c5cff)}
.wss-hero-status{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 9px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-hero-status i{width:6px;height:6px;border-radius:50%;background:#94a3b8;display:block}
.wss-hero-status[data-tone="ok"]{background:rgba(22,163,74,.13);color:var(--dsw-alias-state-success-primary,#177a3b)}
.wss-hero-status[data-tone="ok"] i{background:currentColor}
.wss-hero-status[data-tone="danger"]{background:rgba(220,38,38,.13);color:var(--dsw-alias-state-error-primary,#b42318)}
.wss-hero-status[data-tone="danger"] i{background:currentColor}
.wss-chip{font-size:11px;padding:3px 8px;border-radius:999px;border:1px solid color-mix(in srgb,var(--wp-accent) 34%,var(--dsw-alias-border-l2,var(--wp-panel-border)));color:var(--wp-accent);background:color-mix(in srgb,var(--wp-accent) 10%,transparent)}
/* 快捷导航（sticky） */
.wss-nav{position:sticky;top:0;z-index:3;display:flex;gap:4px;padding:4px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:color-mix(in srgb,var(--dsw-alias-bg-layer-3,var(--wp-panel-bg)) 88%,transparent);backdrop-filter:blur(10px);overflow-x:auto;scrollbar-width:none}
.wss-nav::-webkit-scrollbar{display:none}
.wss-nav-item{flex:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary,var(--wp-text));font:inherit;font-size:12px;padding:6px 12px;border-radius:8px;cursor:pointer;transition:background-color .15s ease,color .15s ease}
.wss-nav-item:hover{background:rgba(127,127,127,.14);color:var(--dsw-alias-label-primary,var(--wp-text))}
.wss-nav-item:focus-visible{outline:2px solid var(--wp-accent);outline-offset:1px}
/* 分组 / 两列并排 / 高级折叠 */
.wss-group{display:flex;flex-direction:column;gap:14px;scroll-margin-top:64px}
.wss-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;align-items:start}
/* 真实 DSH 设置区约 560px：Hero 保持左图右信息（只缩略图缩小）；≤520px 外观/播放单列；≤440px 才堆叠 Hero */
@container (max-width:620px){.wss-hero-media{flex:0 0 160px;width:160px}}
@container (max-width:600px){.wss-pair{grid-template-columns:minmax(0,1fr)}}
@container (max-width:440px){.wss-hero{flex-direction:column;align-items:stretch}.wss-hero-media{width:100%;flex:none;aspect-ratio:21/9}}
/* 壁纸库列数：真实 DSH 设置区约 560px → 固定 3 列；再窄降 2 列，超宽升 4 列 */
@container (max-width:440px){.wss-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@container (min-width:900px){.wss-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}
.wss-advanced{display:flex;flex-direction:column;gap:10px;scroll-margin-top:64px}
.wss-details{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));border-radius:14px;background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));overflow:hidden;transition:border-color .15s ease}
.wss-details[open]{border-color:color-mix(in srgb,var(--wp-accent) 36%,var(--dsw-alias-border-l2,var(--wp-panel-border)))}
.wss-details-head{display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;list-style:none;user-select:none;transition:background-color .15s ease}
.wss-details-head:hover{background:rgba(127,127,127,.06)}
.wss-details[open] .wss-details-head{border-bottom:1px dashed var(--dsw-alias-border-l2,var(--wp-panel-border))}
.wss-details-head::-webkit-details-marker{display:none}
.wss-details-head::after{content:"";width:7px;height:7px;margin-left:auto;border-right:1.6px solid var(--dsw-alias-label-tertiary,var(--wp-text));border-bottom:1.6px solid var(--dsw-alias-label-tertiary,var(--wp-text));transform:rotate(45deg);transition:transform .15s ease}
.wss-details[open] .wss-details-head::after{transform:rotate(-135deg)}
.wss-details-head:focus-visible{outline:2px solid var(--wp-accent);outline-offset:-2px}
.wss-details-title{font-size:13.5px;font-weight:650}
.wss-details-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,var(--wp-text));margin-left:auto;padding-right:10px}
.wss-details-hint[data-tone="failed"]{color:var(--dsw-alias-state-error-primary,#b42318)}
.wss-details-body{padding:0 16px 14px;display:flex;flex-direction:column;gap:10px}
/* 壁纸库工具栏：搜索 + 排序一行，类型/过滤一行 */
.wss-library-tools{display:flex;flex-direction:column;gap:8px;margin-bottom:12px}
.wss-search-row{display:flex;gap:8px;align-items:center}
.wss-search{flex:1 1 auto;min-width:0;height:34px;border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background-color:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06));background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14'%3E%3Ccircle cx='6' cy='6' r='4.2' fill='none' stroke='%238892a0' stroke-width='1.5'/%3E%3Cpath d='M9.2 9.2L13 13' stroke='%238892a0' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:11px center;color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:9px;padding:0 12px 0 32px;font:inherit;font-size:12.5px}
.wss-search::placeholder{color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wss-search:focus-visible{outline:2px solid var(--wp-accent);outline-offset:1px}
.wss-filter-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px 10px}
.wss-tool{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text));white-space:nowrap;cursor:pointer;padding:3px 2px}
.wss-tool input[type=checkbox]{margin:0;accent-color:var(--wp-accent)}
/* 壁纸卡片：16:9 预览 + 单行标题；hover/focus 浮出收藏/隐藏 */
.wss-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;max-height:372px;overflow-y:auto;padding:2px;scrollbar-width:thin;scrollbar-color:rgba(127,127,127,.45) transparent}
.wss-grid::-webkit-scrollbar{width:8px}
.wss-grid::-webkit-scrollbar-thumb{background:rgba(127,127,127,.38);border-radius:4px}
.wss-grid::-webkit-scrollbar-track{background:transparent}
.wss-thumb-wrap{position:relative;min-width:0;border-radius:11px}
.wss-thumb-wrap > .wss-thumb{width:100%}
.wss-thumb-actions{position:absolute;left:8px;top:8px;display:flex;gap:5px;z-index:1;opacity:0;transform:translateY(-3px);transition:opacity .15s ease,transform .15s ease}
.wss-thumb-wrap:hover .wss-thumb-actions,.wss-thumb-wrap:focus-within .wss-thumb-actions{opacity:1;transform:none}
@media (hover:none){.wss-thumb-actions{opacity:1;transform:none}}
.wss-fav,.wss-hide{display:flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:7px;background:var(--wp-badge-bg);color:var(--wp-badge-fg);font:inherit;font-size:12px;line-height:1;cursor:pointer;backdrop-filter:blur(6px)}
.wss-fav:hover,.wss-hide:hover{filter:brightness(1.25)}
.wss-fav:focus-visible,.wss-hide:focus-visible{outline:2px solid var(--wp-accent);outline-offset:2px}
.wss-fav-on{color:var(--dsw-alias-state-warning-primary,#f5b301)}
.wss-hide-on{color:var(--dsw-alias-label-tertiary,#d0d0d0)}
.wss-thumb{display:flex;flex-direction:column;gap:6px;padding:5px;background:transparent;border:1px solid transparent;border-radius:11px;cursor:pointer;color:var(--dsw-alias-label-primary,var(--wp-text));font:inherit;text-align:left;min-width:0;transition:background-color .15s ease,transform .15s ease}
.wss-thumb:hover{background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.1));transform:translateY(-2px)}
.wss-thumb:focus-visible{outline:2px solid var(--wp-accent);outline-offset:2px}
.wss-thumb-media{position:relative;display:block;width:100%;aspect-ratio:16/9;border-radius:9px;overflow:hidden;background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.12))}
.wss-thumb-media img{width:100%;height:100%;object-fit:cover;display:block}
.wss-thumb .wss-no-preview{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wss-badge{position:absolute;left:7px;bottom:7px;font-size:9px;line-height:1;letter-spacing:.05em;padding:3px 6px;border-radius:5px;background:var(--wp-badge-bg);color:var(--wp-badge-fg);backdrop-filter:blur(6px)}
.wss-check{position:absolute;right:7px;top:7px;width:19px;height:19px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;background:var(--wp-accent);color:#fff;box-shadow:0 2px 6px rgba(0,0,0,.28)}
.wss-thumb-title{font-size:12px;line-height:1.35;padding:2px 3px 3px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}
.wss-thumb.wss-selected .wss-thumb-media{box-shadow:0 0 0 2px var(--wp-accent),0 6px 16px rgba(15,17,22,.16)}
.wss-empty{margin:10px 0 0;padding:18px 14px;text-align:center;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-tertiary,var(--wp-text));border:1px dashed var(--dsw-alias-border-l2,var(--wp-panel-border));border-radius:10px}
/* 控件行：标签左、控件右；复选框统一渲染成开关 */
.wss-row,.wss-glow-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:34px;margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-row input[type=checkbox],.wss-glow-row input[type=checkbox]{appearance:none;-webkit-appearance:none;order:2;margin:0;flex:none;width:36px;height:20px;border-radius:999px;background:rgba(100,105,120,.4);position:relative;cursor:pointer;transition:background-color .15s ease;box-shadow:inset 0 0 0 1px rgba(0,0,0,.10)}
.wss-row input[type=checkbox]::before,.wss-glow-row input[type=checkbox]::before{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .15s ease}
.wss-row input[type=checkbox]:checked,.wss-glow-row input[type=checkbox]:checked{background:var(--wp-accent)}
.wss-row input[type=checkbox]:checked::before,.wss-glow-row input[type=checkbox]:checked::before{transform:translateX(16px)}
.wss-row input[type=checkbox]:focus-visible,.wss-glow-row input[type=checkbox]:focus-visible{outline:2px solid var(--wp-accent);outline-offset:2px}
.wss-effects,.wss-power,.wss-rotation,.wss-textcolor{display:flex;flex-direction:column;gap:10px}
.wss-glow{border-top:1px dashed var(--dsw-alias-border-l2,var(--wp-panel-border));padding-top:10px;margin-top:10px;display:flex;flex-direction:column;gap:10px}
.wss-rotation-status{margin:0}
.wss-rotation-status[data-state="empty"]{color:var(--dsw-alias-state-warning-primary,#f5b301)}
.wss-sound-row{display:flex;flex-direction:column;margin-top:2px}
/* 滑杆：标签行（数值 chip）+ 全宽轨道 */
.wss-slider{display:flex;flex-direction:column;gap:5px;font-size:12.5px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-slider-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.wss-value,.wss-effect-value{font-variant-numeric:tabular-nums;font-size:11.5px;font-weight:650;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-primary,var(--wp-text))}
.wss-slider input[type=range]{width:100%;height:20px;margin:0;background:transparent;appearance:none;-webkit-appearance:none;cursor:pointer}
.wss-slider input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:rgba(127,127,127,.25)}
.wss-slider input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:var(--wp-accent);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.28)}
.wss-slider input[type=range]::-moz-range-track{height:4px;border-radius:2px;background:rgba(127,127,127,.25)}
.wss-slider input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--wp-accent);border:2px solid #fff}
.wss-slider input[type=range]:focus-visible{outline:2px solid var(--wp-accent);outline-offset:2px}
/* 下拉 / 文本输入：统一 32px 高与自定义箭头 */
.wss-quality,.wss-fit-mode,.wss-type-filter,.wss-sort,.wss-rotation-interval,.wss-rotation-order,.wss-userprop-select{appearance:none;-webkit-appearance:none;min-height:32px;border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background-color:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;padding:5px 30px 5px 10px;font:inherit;font-size:12px;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238892a0' stroke-width='1.5'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;cursor:pointer}
.wss-fit-mode:focus-visible,.wss-quality:focus-visible,.wss-type-filter:focus-visible,.wss-sort:focus-visible,.wss-rotation-interval:focus-visible,.wss-rotation-order:focus-visible,.wss-userprop-select:focus-visible{outline:2px solid var(--wp-accent);outline-offset:1px}
.wss-sort{flex:none;max-width:142px}
/* 文字可读性：颜色选择复用 .wss-row；color 输入按平台补最小样式 */
.wss-row input[type=color]{width:44px;height:26px;order:2;flex:none;padding:0;border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));border-radius:6px;background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));cursor:pointer}
/* 壁纸属性四类型控件：控件在左、恢复默认在右；condition 不满足整项标灰 */
.wss-userprops-list{display:flex;flex-direction:column;gap:8px;margin-top:2px}
.wss-userprop-item{display:flex;align-items:center;gap:10px;min-width:0}
.wss-userprop-main{flex:1;min-width:0;margin:0}
.wss-userprop-label{display:inline-flex;align-items:baseline;gap:4px;min-width:0}
.wss-userprop-hint{font-size:11px;color:var(--dsw-alias-state-warning-primary,#f5b301)}
.wss-userprop-value{font-variant-numeric:tabular-nums;font-size:11.5px;font-weight:650;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-primary,var(--wp-text))}
.wss-userprop-select{max-width:180px}
.wss-userprops .wss-userprop-reset{flex:none;min-height:28px;padding:4px 10px;font-size:11.5px}
.wss-userprop-item[data-disabled="true"]{opacity:.55}
.wss-userprop-item[data-disabled="true"] .wss-userprop-reset{cursor:not-allowed}
.wss-userprops .wss-slider{margin:0}
/* 按钮：primary / secondary / ghost 三档 */
.wss-cancel,.wss-save-dirs,.wss-probe,.wss-adopt,.wss-refresh,.wss-live-retry,.wss-live-forget,.wss-media-dismiss,.wss-userprop-reset{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:transparent;color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;min-height:32px;padding:7px 13px;font:inherit;font-size:12px;font-weight:550;cursor:pointer;transition:background-color .15s ease,filter .15s ease,transform .1s ease}
.wss-cancel:hover,.wss-save-dirs:hover,.wss-probe:hover,.wss-adopt:hover,.wss-refresh:hover,.wss-live-retry:hover,.wss-live-forget:hover,.wss-media-dismiss:hover,.wss-userprop-reset:hover{background:rgba(127,127,127,.12)}
.wss-cancel:active,.wss-save-dirs:active,.wss-probe:active,.wss-adopt:active,.wss-refresh:active,.wss-live-retry:active,.wss-live-forget:active,.wss-media-dismiss:active,.wss-userprop-reset:active{transform:translateY(1px)}
.wss-cancel:focus-visible,.wss-save-dirs:focus-visible,.wss-probe:focus-visible,.wss-adopt:focus-visible,.wss-refresh:focus-visible,.wss-live-retry:focus-visible,.wss-live-forget:focus-visible,.wss-media-dismiss:focus-visible,.wss-userprop-reset:focus-visible{outline:2px solid var(--wp-accent);outline-offset:2px}
.wss-refresh,.wss-save-dirs{background:var(--wp-accent-strong,#2563eb);border-color:transparent;color:#fff;box-shadow:0 2px 8px rgba(37,99,235,.28)}
.wss-refresh:hover,.wss-save-dirs:hover{background:var(--wp-accent-strong,#2563eb);filter:brightness(1.07)}
/* 目录字段与探测结果 */
.wss-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-field-label{color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-field input{height:34px;border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.06));color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;padding:0 10px;font:inherit;font-size:12px}
.wss-field input:focus-visible{outline:2px solid var(--wp-accent);outline-offset:1px}
.wss-dir-actions{display:flex;gap:8px;margin-top:2px}
.wss-probe-result{display:flex;flex-direction:column;gap:6px;border-top:1px dashed var(--dsw-alias-border-l2,var(--wp-panel-border));padding-top:12px;margin-top:14px}
.wss-subtitle{margin:2px 0 0;font-size:12px;font-weight:650}
.wss-candidate{display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:8px;background:var(--dsw-alias-bg-module-platform,rgba(127,127,127,.08))}
.wss-candidate-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-family:ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-exists{color:var(--dsw-alias-state-success-primary,#4caf50);font-size:11px;white-space:nowrap}
.wss-missing{color:var(--dsw-alias-label-tertiary,var(--wp-text));font-size:11px;white-space:nowrap}
.wss-message{margin:0;padding:9px 12px;border-radius:9px;background:rgba(127,127,127,.1);font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
/* 媒体失败提示条（Hero 下方） */
.wss-alert{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 14px;border:1px solid rgba(220,38,38,.28);background:rgba(220,38,38,.08);border-radius:12px}
.wss-alert p{margin:0;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary,var(--wp-text))}
/* 实时渲染状态行：主行讲现状、次级行讲失败记忆 */
.wss-live-status{display:flex;flex-direction:column;gap:2px;margin-bottom:10px}
.wss-live-status .wss-live-current,.wss-live-status .wss-live-memory{margin:0}
.wss-live-status[data-state="failed"] .wss-live-current,.wss-live-status .wss-live-memory{color:var(--dsw-alias-state-error-primary,var(--wp-accent-strong))}
@media (prefers-reduced-motion:reduce){.wss-thumb,.wss-cancel,.wss-save-dirs,.wss-probe,.wss-adopt,.wss-refresh,.wss-live-retry,.wss-live-forget,.wss-userprop-reset,.wss-nav-item,.wss-details-head::after{transition:none}.wss-thumb:hover{transform:none}}

/* ── 文字颜色跟随壁纸亮度（2026-09-03 定稿） ──
   不遮背景、不改壁纸可见度；只让消息列（[class*="flowItem"] 内主要文本）的
   文字颜色跟随壁纸亮度自动切换：暗壁纸→白字、亮壁纸→黑字。颜色经 --wp-chat-fg
   变量（background-layer.js setChatFg 写），fallback 到 DSH 主题文字色（未测量时）。
   选择器用 flowItem 子元素（稳，不依赖 DSH 的 CSS module 哈希类）。
   ⚠ code（行内代码）有独立不透明背景（浅色近白 --dsw-alias-markdown-inline-code），
   其文字必须用与背景对比的 DSH 主题色（--dsw-alias-label-primary：浅=黑/深=白），
   不能被 --wp-chat-fg 反色——否则暗壁纸下父级变白字，code 继承成白字白底。
   （2026-10-01）该变量也可由设置面板**手动指定**（auto/白/黑/自定义）；并新增描边变量
   --wp-chat-outline（对立色阴影，按当前文字色算，0 档 = 移除变量 = none）。
   ⚠ 描边只加在「贴壁纸的透明文字」上：实底气泡/卡片/code/输入框不加（会发脏）。
   color 是可继承属性，故须给 code 显式覆盖继承（不随壁纸亮度，只随主题）。 */
body[data-we-wallpaper] [class*="flowItem"] p,
body[data-we-wallpaper] [class*="flowItem"] span,
body[data-we-wallpaper] [class*="flowItem"] li,
body[data-we-wallpaper] [class*="flowItem"] td,
body[data-we-wallpaper] [class*="flowItem"] th,
body[data-we-wallpaper] [class*="flowItem"] h1,
body[data-we-wallpaper] [class*="flowItem"] h2,
body[data-we-wallpaper] [class*="flowItem"] h3,
body[data-we-wallpaper] [class*="flowItem"] blockquote,
body[data-we-wallpaper] [class*="flowItem"] [class*="actions"]{
  color:var(--wp-chat-fg,var(--dsw-alias-label-primary,inherit));
  text-shadow:var(--wp-chat-outline,none);
}
/* actions 内操作 SVG 图标（fill="currentColor" 继承容器 color）跟随壁纸亮度。
   容器及父背景透明（贴壁纸），故跟随 --wp-chat-fg 反色安全，不会白底白图标。 */
body[data-we-wallpaper] [class*="flowItem"] [class*="actions"] svg{
  color:var(--wp-chat-fg,var(--dsw-alias-label-primary,inherit));
}
/* 文件链接（[class*="fileLink"] 等，贴在壁纸上、背景透明）跟随壁纸亮度：
   DSH 给它们固定深灰（--dsw-alias-label-secondary），暗壁纸下看不清 → 反色。
   同时兜底一般 <a> 链接（同样贴壁纸）。 */
body[data-we-wallpaper] [class*="flowItem"] a,
body[data-we-wallpaper] [class*="flowItem"] [class*="fileLink"],
body[data-we-wallpaper] [class*="flowItem"] [class*="_file"]{
  color:var(--wp-chat-fg,var(--dsw-alias-label-primary,inherit));
  text-shadow:var(--wp-chat-outline,none);
}
/* 聊天顶部 header（会话标题栏 wSkVaW_header / headerActions / headerUtilities）：
   背景透明贴壁纸，文字/图标用固定深灰 → 暗壁纸下看不清。跟随 --wp-chat-fg 反色。
   ChatHeader 组件类（wSkVaW_header 前缀），其操作图标 fill="currentColor" 继承容器 color。 */
body[data-we-wallpaper] [class*="wSkVaW_header"],
body[data-we-wallpaper] [class*="wSkVaW_header"] *{
  color:var(--wp-chat-fg,var(--dsw-alias-label-primary,inherit));
  text-shadow:var(--wp-chat-outline,none);
}
/* li 列表点（::marker）：DSH 给 marker 单独设深灰（--dsw-alias-label-secondary），
   覆盖了继承；li 文本已跟随 --wp-chat-fg 但点仍是深灰 → 暗壁纸下看不清。
   让 marker 同样跟随 --wp-chat-fg 反色。 */
body[data-we-wallpaper] [class*="flowItem"] li::marker{
  color:var(--wp-chat-fg,var(--dsw-alias-label-primary,inherit));
}
/* 行内代码/代码块：显式主题色（覆盖父级继承的 --wp-chat-fg），保证与其背景对比正确；
   text-shadow 同样显式复位（它可继承，且消息列 p/span 规则会命中 code 内的文字）。 */
body[data-we-wallpaper] [class*="flowItem"] code,
body[data-we-wallpaper] [class*="flowItem"] pre code{
  color:var(--dsw-alias-label-primary,inherit);
  text-shadow:none;
}
/* 消息气泡（.Sixlwa_bubble 等有 --dsw-specific-bubble 背景）：气泡有独立不透明背景
   （浅色=淡蓝 #edf3fe、深色=深灰），内部文字必须用与背景对比的主题色（--dsw-alias-label-primary：
   浅=黑/深=白）。不能被 --wp-chat-fg 反色（否则暗壁纸下白字贴淡蓝底看不清）。 */
body[data-we-wallpaper] [class*="flowItem"] [class*="bubble"],
body[data-we-wallpaper] [class*="flowItem"] [class*="bubble"] p,
body[data-we-wallpaper] [class*="flowItem"] [class*="bubble"] span,
body[data-we-wallpaper] [class*="flowItem"] [class*="bubble"] li,
body[data-we-wallpaper] [class*="flowItem"] [class*="bubble"] code{
  color:var(--dsw-alias-label-primary,inherit);
  /* 气泡有实底：文字描边必须复位（否则用户的描边会渗进气泡内，浅底黑边发脏） */
  text-shadow:none;
}

/* ── 通知卡片（turn-trigger，「收到任务消息」）是实底（AGENT.md §5.42） ──
   与气泡/卡片同口径：卡内文字用主题色（不被 --wp-chat-fg 反色）、描边复位；
   header（图标/标题/时间）与说明文字保留 DSH 的层级色。
   ⚠ 必须带 [class*="flowItem"] 前缀：消息列反色规则是 [class*="flowItem"] p（(0,2,2)），
   通配后代 [data-turn-trigger] * 只有 (0,2,1)（* 不贡献具体度）⇒ 少了前缀压不过它。 */
body[data-we-wallpaper] [class*="flowItem"] [data-turn-trigger],
body[data-we-wallpaper] [class*="flowItem"] [data-turn-trigger] *{
  color:var(--dsw-alias-label-primary,inherit);
  text-shadow:none;
}
body[data-we-wallpaper] [class*="flowItem"] [data-turn-trigger] > button,
body[data-we-wallpaper] [class*="flowItem"] [data-turn-trigger] > button *{
  color:var(--dsw-alias-label-tertiary,inherit);
}
body[data-we-wallpaper] [class*="flowItem"] [data-turn-trigger] [class*="explanation"]{
  color:var(--dsw-alias-label-secondary,inherit);
}

/* ── 自带实底的卡片：不跟随壁纸亮度反色（2026-09-18） ──
   present 文件卡片（[data-presented-file]）与「本回合改动文件」卡片（[data-changed-files]）
   都有自己不透明的底（--deliverable-fill / --changes-fill），卡内文字靠继承取
   --dsw-alias-label-primary。上面的 --wp-chat-fg 反色会覆盖这份继承：浅色主题下卡片是浅底、
   文字却被反成白字 → 白底白字看不见（深色主题下两者恰好同色，所以只有浅色暴露）。
   这里按主题色恢复卡内文字，并保留次要文字与增删计数的层级色。
   ⚠ 2026-09-18 订正：改动文件卡片 DSH **只给 header 上了 --changes-fill**，
   卡片本体与文件行列表（.list）背景是透明的——只改文字色会让列表里的深色文字压壁纸。
   故给卡片本体补上同一个 --changes-fill，与 header 连成一张完整的卡。 */
body[data-we-wallpaper] [class*="flowItem"] [data-changed-files]{
  background:var(--changes-fill,rgba(0,0,0,.04));
}
body[data-we-wallpaper] [class*="flowItem"] [data-presented-file],
body[data-we-wallpaper] [class*="flowItem"] [data-presented-file] *,
body[data-we-wallpaper] [class*="flowItem"] [data-changed-files],
body[data-we-wallpaper] [class*="flowItem"] [data-changed-files] *{
  color:var(--dsw-alias-label-primary,inherit);
  /* 卡片有实底：文字描边必须复位（可继承属性会从消息列规则渗进来） */
  text-shadow:none;
}
body[data-we-wallpaper] [class*="flowItem"] [data-presented-file] [class*="description"]{
  color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-primary));
}
body[data-we-wallpaper] [class*="flowItem"] [data-presented-file] [class*="description"][data-error="true"]{
  color:var(--dsw-alias-state-error-primary);
}
body[data-we-wallpaper] [class*="flowItem"] [data-changed-files] [class*="stat"],
body[data-we-wallpaper] [class*="flowItem"] [data-changed-files] [class*="row"]{
  color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));
}
body[data-we-wallpaper] [class*="flowItem"] [data-changed-files] [class*="added"]{
  color:var(--dsw-alias-state-success-primary);
}
body[data-we-wallpaper] [class*="flowItem"] [data-changed-files] [class*="deleted"]{
  color:var(--dsw-alias-state-error-primary);
}

/* ── 宽表格（.md-table-wide）约束：2026-08-26 为液态玻璃气泡配套加入。
   现消息气泡（flowItem）已改回 DSH 原生样式（2026-08-31），气泡交给 DSH 原生
   处理，此前的"把宽表格约束回气泡内容区"覆盖不再需要（且会与 DSH 原生竞争），
   故移除，交还 DSH 原生对 .md-table-wide 的约束。 ── */

/* ── 插件管理页（DSH 0.1.6 新增页，2026-09-18） ──
   该页容器与卡片背景全透明，插件又把 --dsw-alias-bg-base 置成 transparent 让壁纸透出，
   卡片文字便直接压在壁纸上（深色主题白字 / 浅色主题被压暗的黑字）→ 读不清。
   这里只给卡片补半透明底、给页头与分组标题补对比；页面其余部分壁纸照旧透出。
   锚点全部用稳定属性，不依赖 CSS module 哈希类名；不碰共用中间列 pI_x6G_centerCol，
   因此对话页与别的页面不受影响。卡片有两类：data-plugin-package（已安装的包）
   与 data-plugin-item（内置项），都要覆盖。 */
body[data-we-wallpaper] [data-plugin-panel]{
  --wp-card-bg:rgba(255,255,255,.72);
  --wp-card-bg-hover:rgba(255,255,255,.88);
  --wp-chip-bg:rgba(255,255,255,.78);
}
body[data-ds-dark-theme][data-we-wallpaper] [data-plugin-panel]{
  --wp-card-bg:rgba(16,18,24,.62);
  --wp-card-bg-hover:rgba(32,36,46,.78);
  --wp-chip-bg:rgba(16,18,24,.6);
}
body[data-we-wallpaper] [data-plugin-panel] li:is([data-plugin-package],[data-plugin-item]){
  background:var(--wp-card-bg);
}
body[data-we-wallpaper] [data-plugin-panel] li:is([data-plugin-package],[data-plugin-item]):hover{
  background:var(--wp-card-bg-hover);
}
/* 页头标题/副标题、分组标题（列表页）、区块标题（详情页）常压在亮壁纸段上：
   浅色主题下这些文字被插件压成黑字，压在亮部尤其糊，只加阴影救不回来；而且 pageHead 里的
   「＋ 添加插件」是 DSH 原生实底按钮，给它加 text-shadow 会让按钮文字发脏（2026-09-18 实测）。
   故不靠阴影，改为各补一块只裹住文字本身的 chip 底：fit-content 不铺满整行，尽量少遮壁纸；
   详情页的 sectionHead 把标题与「共 N 个 · N 运行中」统计一起裹进去。 */
body[data-we-wallpaper] [data-plugin-panel] [class*="groupTitle"],
body[data-we-wallpaper] [data-plugin-panel] [class*="sectionHead"],
body[data-we-wallpaper] [data-plugin-panel] [class*="pageTitle"],
body[data-we-wallpaper] [data-plugin-panel] [class*="pageIntro"]{
  width:fit-content;
  padding:1px 8px;
  border-radius:6px;
  background:var(--wp-chip-bg);
}

/* ── 插件详情页（列表页的下一层，2026-09-18） ──
   详情页与列表页同属 [data-plugin-panel]，同样整片透明：头部（标题/版本/包名/描述）
   与「包含的组件」行都直接压壁纸。给头部块与每个组件行补同一套卡片底。
   锚点继续用稳定属性（data-plugin-detail / data-plugin-row），不依赖哈希类名。 */
body[data-we-wallpaper] [data-plugin-panel] [data-plugin-detail] [class*="detailMain"]{
  background:var(--wp-card-bg);
  border-radius:12px;
  padding:12px 14px;
}
body[data-we-wallpaper] [data-plugin-panel] li[data-plugin-row]{
  background:var(--wp-card-bg);
  border-radius:12px;
  padding:12px 14px;
}
body[data-we-wallpaper] [data-plugin-panel] li[data-plugin-row] + li[data-plugin-row]{
  margin-top:6px;
}
/* 面包屑（← 插件列表）：DSH 给的浅灰贴壁纸偏虚。它跟随壁纸亮度反色（同消息区 header 做法），
   并固定配深影——反色后无论白字还是黑字，深影都能再托一层。 */
body[data-we-wallpaper] [data-plugin-panel] [class*="crumb"]{
  color:var(--wp-chat-fg,inherit);
  text-shadow:0 1px 3px rgba(0,0,0,.7);
}

/* ── 右侧栏（文件 / 终端 / 浏览器面板，2026-09-18） ──
   DSH 的右侧栏内容容器 [data-sidebar-right-panel] 原本背景全透明，面板内容（文件树、
   工作区路径、工具图标条）直接压壁纸，浅色主题下黑字压在暗壁纸上大片发虚。
   底挂在这个内容容器上，而不是外层 [data-rightbar-col]：点「全屏」后 DSH 会把面板改成
   position:fixed 铺满视口、脱离 rightbarCol 的 576px 宽，挂外层会整片漏底（实测）。
   自带底的子面板（终端、浏览器 iframe）会盖住这层，不受影响。
   2026-09-23 订正（0.1.7 起右栏出现常驻遮罩）：0.1.7 把「收起」从隐藏容器改成隐藏
   dock 子内容（容器 position:absolute; right:0，仍占侧栏宽度且 visibility:visible），
   收起态容器成了常驻透明空盒子 —— 半透明底必须限定 [data-sidebar-right-open]（三版
   都渲染该属性），否则收起时整条右栏被画成遮罩。
   还必须 :not(fullscreen)：属性限定把半透明底提到 (0,3,1)，会盖过全屏那条 (0,2,1)
   的不透明底 ⇒ 全屏面板漏出壁纸（真机回归）。两个选择器互斥，不靠先后顺序决胜。 */
body[data-we-wallpaper] [data-sidebar-right-panel][data-sidebar-right-open]:not([data-sidebar-right-panel="fullscreen"]){
  background:rgba(255,255,255,.74);
}
body[data-ds-dark-theme][data-we-wallpaper] [data-sidebar-right-panel][data-sidebar-right-open]:not([data-sidebar-right-panel="fullscreen"]){
  background:rgba(24,26,30,.62);
}
/* 全屏（data-sidebar-right-panel="fullscreen"）：面板铺满视口、本该盖住下层 UI。
   半透明的底会让左侧栏与聊天内容透上来（实测 .96 仍有文字残影），故用不透明底色。
   2026-09-23：0.1.7 删掉了旧版面板容器的 z-index:10 ⇒ 容器 z-index:auto，而聊天输入框
   （composerStack）是 z-index:1、面板 dock 是 z-index:40 但全透明 ⇒ 输入框浮在面板之上；
   故下面单独补 z-index（见 after 该块的 :where() 规则）。底与 z-index 都必须限定
   [data-sidebar-right-open]：收起按钮只 toggleExpanded、不改 mode，「全屏 + 未展开」可达
   （面板仍 width:100vw、dock 内容 visibility:hidden），未限定就是一块 100vw 的空盒子盖住
   整个应用（真机「收起后页面全空」）。 */
body[data-we-wallpaper] [data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]{
  background:#fff;
}
body[data-ds-dark-theme][data-we-wallpaper] [data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]{
  background:rgb(24,26,30);
}
/* z-index 只在 DSH 自己没给时生效：旧版 DSH 有
   .P3OORG_panel[data-sidebar-right-panel=fullscreen]{z-index:40}，用 :where() 把本规则
   具体度压到低于它（真机 Chromium 层叠实测：旧版仍取 40，0.1.7 取我们的 15）。 */
body[data-we-wallpaper] :where([data-sidebar-right-panel="fullscreen"][data-sidebar-right-open]){
  z-index:15;
}
/* 关于区（面板最末）：Star / 反馈 / 文档三个 pill 链接。 */
.wss-about-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:2px}
.wss-about-link{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:transparent;color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;min-height:30px;padding:6px 12px;font-size:12px;font-weight:550;text-decoration:none;display:inline-flex;align-items:center;transition:background-color .15s ease,filter .15s ease}
.wss-about-link:hover{background:rgba(127,127,127,.12)}
.wss-about-link:focus-visible{outline:2px solid var(--wp-accent);outline-offset:2px}
.wss-about-link[data-primary=true]{background:var(--wp-accent-strong,#2563eb);border-color:transparent;color:#fff}
.wss-about-link[data-primary=true]:hover{filter:brightness(1.07)}
/* ── 设置页 tab 容器（Wallpaper 壁纸：日常壁纸 / 开机动画） ── */
.we-shell{display:flex;flex-direction:column;gap:var(--we-sp-3);padding:var(--we-sp-2) 2px 6px}
.we-tabs{display:flex;gap:4px;padding:4px;border:1px solid var(--we-border);border-radius:var(--we-r-md);background:var(--we-surface-2)}
.we-tab{flex:1 1 0;min-width:0;height:34px;border:0;border-radius:var(--we-r-sm);background:transparent;color:var(--dsw-alias-label-secondary,var(--wp-text));font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:background-color .15s ease,color .15s ease,box-shadow .15s ease}
.we-tab:hover{background:rgba(127,127,127,.12);color:var(--dsw-alias-label-primary,var(--wp-text))}
.we-tab[aria-selected="true"]{background:var(--wp-accent);color:#fff;box-shadow:var(--we-shadow-card)}
.we-tab:focus-visible{outline:var(--we-ring);outline-offset:2px}
.we-tabpanel{display:flex;flex-direction:column;gap:var(--we-sp-3)}

/* ── 设计系统覆盖（2026-10-30）：统一壁纸面板观感。只改外观值，不改选择器/布局契约；
   旧规则保持不动，供 tests/styles.test.ts 的文本断言继续成立。 ── */
.wss-root{gap:var(--we-sp-3)}
.wss-section{border-color:var(--we-border);background:var(--we-surface);border-radius:var(--we-r-card);padding:var(--we-sp-4);box-shadow:var(--we-shadow-card)}
.wss-details{border-color:var(--we-border);border-radius:var(--we-r-card);background:var(--we-surface)}
.wss-nav{border-color:var(--we-border);border-radius:var(--we-r-md);background:var(--we-surface-2)}
.wss-about-link{border-radius:var(--we-r-sm)}
.wss-nav-item:focus-visible,.wss-thumb:focus-visible,.wss-search:focus-visible,.wss-details-head:focus-visible,.wss-about-link:focus-visible{outline:var(--we-ring);outline-offset:2px}
body[data-ds-dark-theme] .wss-section,
body[data-ds-dark-theme] .wss-details{background:var(--we-surface);border-color:var(--we-border)}

/* ── 开机动画（独立全屏层 + 设置页 tab 内容 wbs-*，2026-10-30 设计系统） ── */
.wp-boot-layer{position:fixed;inset:0;z-index:2147483000;background:#000;overflow:hidden;pointer-events:auto}
.wbs-root{display:flex;flex-direction:column;gap:var(--we-sp-3);padding:var(--we-sp-2) 2px 6px;color:var(--dsw-alias-label-primary,var(--wp-text));font-size:13px;line-height:1.55;container-type:inline-size}
.wbs-loading{color:var(--dsw-alias-label-tertiary,var(--wp-text));padding:var(--we-sp-4)}
/* 状态 hero：标题/说明/上次播放 + 启用开关 */
.wbs-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:var(--we-sp-4);padding:var(--we-sp-4);border:1px solid var(--we-border);border-radius:var(--we-r-hero);background:linear-gradient(135deg,rgba(79,140,255,.10),rgba(147,51,234,.06) 60%,transparent),var(--we-surface);box-shadow:var(--we-shadow-hero)}
.wbs-hero-body{display:flex;flex-direction:column;gap:var(--we-sp-1);min-width:0}
.wbs-hero-title{margin:0;font-size:15px;font-weight:650;letter-spacing:.01em}
.wbs-hero-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,var(--wp-text));max-width:46ch}
.wbs-last{display:inline-flex;align-items:center;gap:6px;margin:2px 0 0;font-size:11.5px;padding:3px 9px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-secondary,var(--wp-text));align-self:flex-start}
.wbs-last::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.8}
.wbs-last[data-tone="ok"]{background:rgba(22,163,74,.13);color:var(--we-ok)}
.wbs-last[data-tone="warn"]{background:rgba(245,158,11,.14);color:var(--we-warn)}
.wbs-last[data-tone="danger"]{background:rgba(220,38,38,.13);color:var(--we-danger)}
/* 开关（与壁纸面板同款胶囊） */
.wbs-switch{display:inline-flex;align-items:center;gap:8px;flex:none;cursor:pointer;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,var(--wp-text));user-select:none}
.wbs-switch input{position:absolute;opacity:0;width:1px;height:1px}
.wbs-switch-track{position:relative;width:38px;height:22px;border-radius:999px;background:rgba(100,105,120,.4);box-shadow:inset 0 0 0 1px rgba(0,0,0,.10);transition:background-color .15s ease}
.wbs-switch-track::before{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.28);transition:transform .15s ease}
.wbs-switch input:checked + .wbs-switch-track{background:var(--wp-accent)}
.wbs-switch input:checked + .wbs-switch-track::before{transform:translateX(16px)}
.wbs-switch input:focus-visible + .wbs-switch-track{outline:var(--we-ring);outline-offset:2px}
/* 分区卡片 */
.wbs-card{display:flex;flex-direction:column;gap:var(--we-sp-3);padding:var(--we-sp-4);border:1px solid var(--we-border);border-radius:var(--we-r-card);background:var(--we-surface);box-shadow:var(--we-shadow-card)}
.wbs-card-head{display:flex;align-items:center;justify-content:space-between;gap:var(--we-sp-2)}
.wbs-title{margin:0;font-size:14px;font-weight:650;display:flex;align-items:center;gap:8px}
.wbs-title::before{content:"";width:3px;height:14px;border-radius:2px;background:var(--wp-accent);flex:none}
.wbs-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wbs-desc{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
/* 素材来源：分段控件 */
.wbs-source-group{display:flex;gap:8px;padding:6px;border:1px solid var(--we-border);border-radius:var(--we-r-md);background:var(--we-surface-2)}
/* 来源选项：选中态必须一眼可辨（accent 描边 + 浅 accent 底 + 右上角 ✓ + 主文字色加粗） */
.wbs-source{position:relative;flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:3px;padding:10px 12px;border:1px solid transparent;border-radius:var(--we-r-sm);cursor:pointer;transition:background-color .15s ease,border-color .15s ease,box-shadow .15s ease}
.wbs-source input{position:absolute;opacity:0;width:1px;height:1px}
.wbs-source-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary,var(--wp-text));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding-right:22px}
.wbs-source-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wbs-source:hover{background:rgba(127,127,127,.10)}
.wbs-source[data-active="true"]{background:color-mix(in srgb,var(--wp-accent) 16%,var(--we-surface));border-color:var(--wp-accent);box-shadow:0 1px 3px rgba(15,17,22,.14)}
.wbs-source[data-active="true"] .wbs-source-label{color:var(--dsw-alias-label-primary,var(--wp-text));font-weight:700}
.wbs-source[data-active="true"] .wbs-source-hint{color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wbs-source[data-active="true"]::after{content:"✓";position:absolute;top:8px;right:9px;width:17px;height:17px;border-radius:50%;background:var(--wp-accent);color:#fff;font-size:11px;font-weight:700;line-height:17px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.wbs-source input:focus-visible + .wbs-source-label{outline:var(--we-ring);outline-offset:3px;border-radius:4px}
/* 素材区（2026-10-30 改版）：当前素材大卡片 + 可视化壁纸网格，让用户一眼看清选中项 */
.wbs-current{display:flex;align-items:center;gap:var(--we-sp-3);padding:10px;border:1px solid var(--we-border);border-radius:var(--we-r-md);background:var(--we-surface-2)}
.wbs-current[data-empty="true"]{border-style:dashed}
.wbs-current-thumb{position:relative;flex:0 0 132px;width:132px;aspect-ratio:16/9;border-radius:var(--we-r-sm);overflow:hidden;background:var(--we-surface);display:flex;align-items:center;justify-content:center;font-size:11px;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wbs-current-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.wbs-current-thumb-file{font-size:18px;color:var(--wp-accent)}
.wbs-current-info{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.wbs-current-label{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wbs-current-title{font-size:14px;font-weight:650;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary,var(--wp-text))}
.wbs-current-meta{font-size:11.5px;line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wbs-choose{flex:none;height:32px;padding:0 12px;border-radius:var(--we-r-sm);border:1px solid var(--we-border);background:transparent;color:var(--dsw-alias-label-primary,var(--wp-text));font:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:background-color .15s ease}
.wbs-choose:hover{background:rgba(127,127,127,.12)}
.wbs-choose:focus-visible{outline:var(--we-ring);outline-offset:2px}
.wbs-picker{display:flex;flex-direction:column;gap:8px}
.wbs-wallpaper-search{height:32px;padding:0 10px;border-radius:var(--we-r-sm);border:1px solid var(--we-border);background-color:var(--we-surface-2);color:var(--dsw-alias-label-primary,var(--wp-text));font:inherit;font-size:12px}
.wbs-wallpaper-search:focus-visible{outline:var(--we-ring);outline-offset:1px}
.wbs-wallpaper-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;max-height:232px;overflow-y:auto;padding:2px;scrollbar-width:thin;scrollbar-color:rgba(127,127,127,.45) transparent}
.wbs-wallpaper-grid::-webkit-scrollbar{width:8px}
.wbs-wallpaper-grid::-webkit-scrollbar-thumb{background:rgba(127,127,127,.38);border-radius:4px}
.wbs-wallpaper-card{display:flex;flex-direction:column;gap:4px;padding:4px;border:1px solid transparent;border-radius:var(--we-r-sm);background:transparent;color:var(--dsw-alias-label-primary,var(--wp-text));font:inherit;text-align:left;min-width:0;cursor:pointer;transition:background-color .15s ease,border-color .15s ease}
.wbs-wallpaper-card:hover{background:rgba(127,127,127,.10)}
.wbs-wallpaper-card[data-selected="true"]{border-color:var(--wp-accent);background:color-mix(in srgb,var(--wp-accent) 8%,transparent)}
.wbs-wallpaper-card:focus-visible{outline:var(--we-ring);outline-offset:1px}
.wbs-wallpaper-thumb{position:relative;display:block;aspect-ratio:16/9;border-radius:6px;overflow:hidden;background:var(--we-surface-2)}
.wbs-wallpaper-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.wbs-wallpaper-kind{position:absolute;left:6px;bottom:6px;font-size:9.5px;line-height:1;padding:3px 5px;border-radius:4px;background:rgba(0,0,0,.62);color:#fff}
.wbs-wallpaper-title{font-size:11.5px;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wbs-wallpaper-empty{grid-column:1/-1;text-align:center;padding:10px 0}
.wbs-probe-inline{align-self:flex-start;height:30px;padding:0 10px;border:1px solid var(--we-border);border-radius:var(--we-r-sm);background:transparent;color:var(--dsw-alias-label-secondary,var(--wp-text));font:inherit;font-size:11.5px;cursor:pointer}
.wbs-probe-inline:hover{background:rgba(127,127,127,.12)}
.wbs-probe-inline:focus-visible{outline:var(--we-ring);outline-offset:2px}
/* 本地视频路径 */
.wbs-local{display:flex;flex-direction:column;gap:6px}
.wbs-local[data-active="false"]{opacity:.55}
.wbs-row{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wbs-local-row{width:100%}
.wbs-row input[type=text]{flex:1;min-width:160px;height:34px;padding:0 10px;border-radius:var(--we-r-sm);border:1px solid var(--we-border);background-color:var(--we-surface-2);color:var(--dsw-alias-label-primary,var(--wp-text));font:inherit;font-size:12.5px}
.wbs-row input[type=text]:focus-visible{outline:var(--we-ring);outline-offset:1px}
.wbs-row button{height:34px;padding:0 12px;border-radius:var(--we-r-sm);border:1px solid var(--we-border);background:transparent;color:var(--dsw-alias-label-primary,var(--wp-text));font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:background-color .15s ease}
.wbs-row button:hover{background:rgba(127,127,127,.12)}
.wbs-row button:focus-visible{outline:var(--we-ring);outline-offset:2px}
.wbs-probe-result{margin:0;font-size:11.5px;line-height:1.5}
.wbs-probe-result[data-tone="ok"]{color:var(--we-ok)}
.wbs-probe-result[data-tone="danger"]{color:var(--we-danger)}
/* 展示方式 2×2 卡片（示意线框）；选中态与素材来源同一套信号：accent 描边 + 浅 accent 底 + ✓ 角标 + 加粗 */
.wbs-fit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--we-sp-2)}
.wbs-fit-card{position:relative;display:flex;flex-direction:column;gap:6px;padding:10px;border:1px solid transparent;border-radius:var(--we-r-md);background:var(--we-surface-2);cursor:pointer;transition:border-color .15s ease,background-color .15s ease,box-shadow .15s ease}
.wbs-fit-card input{position:absolute;opacity:0;width:1px;height:1px}
.wbs-fit-card:hover{background:rgba(127,127,127,.10)}
.wbs-fit-card[data-active="true"]{border-color:var(--wp-accent);background:color-mix(in srgb,var(--wp-accent) 16%,var(--we-surface));box-shadow:0 1px 3px rgba(15,17,22,.14)}
.wbs-fit-card[data-active="true"] .wbs-fit-label{color:var(--dsw-alias-label-primary,var(--wp-text));font-weight:700}
.wbs-fit-card[data-active="true"]::after{content:"✓";position:absolute;top:6px;right:6px;z-index:1;width:17px;height:17px;border-radius:50%;background:var(--wp-accent);color:#fff;font-size:11px;font-weight:700;line-height:17px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.wbs-fit-card[data-disabled="true"]{opacity:.45;cursor:not-allowed}
.wbs-fit-art{display:block;height:44px;border-radius:6px;border:1px dashed var(--we-border);position:relative;overflow:hidden;background:var(--we-surface)}
.wbs-fit-art::after{content:"";position:absolute;background:var(--wp-accent);opacity:.55}
.wbs-fit-art[data-fit="cover"]::after{inset:-14%}
.wbs-fit-art[data-fit="contain"]::after{inset:22% 30%}
.wbs-fit-art[data-fit="stretch"]::after{inset:12% 4%}
.wbs-fit-art[data-fit="tile"]::after{inset:10%;background-image:linear-gradient(90deg,var(--wp-accent) 50%,transparent 50%);background-size:10px 10px;opacity:.35}
.wbs-fit-label{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,var(--wp-text))}
.wbs-fit-hint{font-size:11px;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wbs-fit-card input:focus-visible + .wbs-fit-art{outline:var(--we-ring);outline-offset:2px}
/* 最长播放 */
.wbs-value{font-variant-numeric:tabular-nums;font-size:11.5px;font-weight:650;padding:2px 8px;border-radius:999px;background:rgba(127,127,127,.12);color:var(--dsw-alias-label-primary,var(--wp-text))}
.wbs-slider{display:flex;flex-direction:column;gap:8px}
.wbs-slider input[type=range]{width:100%;height:20px;margin:0;background:transparent;appearance:none;-webkit-appearance:none;cursor:pointer}
.wbs-slider input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:rgba(127,127,127,.25)}
.wbs-slider input[type=range]::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:var(--wp-accent);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.28)}
.wbs-slider input[type=range]::-moz-range-track{height:4px;border-radius:2px;background:rgba(127,127,127,.25)}
.wbs-slider input[type=range]::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:var(--wp-accent);border:2px solid #fff}
.wbs-slider input[type=range]:focus-visible{outline:var(--we-ring);outline-offset:2px}
/* 试播 */
.wbs-actions{display:flex;align-items:center;gap:var(--we-sp-3);flex-wrap:wrap}
.wbs-preview{min-height:36px;padding:0 18px;border:0;border-radius:var(--we-r-sm);background:var(--wp-accent-strong,#2563eb);color:#fff;font:inherit;font-size:13px;font-weight:650;cursor:pointer;box-shadow:var(--we-shadow-card);transition:filter .15s ease}
.wbs-preview:hover{filter:brightness(1.07)}
.wbs-preview:disabled{opacity:.6;cursor:progress}
.wbs-preview:focus-visible{outline:var(--we-ring);outline-offset:2px}
.wbs-message{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wbs-message[data-tone="ok"]{color:var(--we-ok)}
.wbs-message[data-tone="warn"]{color:var(--we-warn)}
.wbs-message[data-tone="danger"]{color:var(--we-danger)}
@container (max-width:520px){.wbs-current{flex-direction:column;align-items:stretch}.wbs-current-thumb{width:100%;flex:none;aspect-ratio:21/9}.wbs-wallpaper-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.wbs-fit-grid{grid-template-columns:minmax(0,1fr)}.wbs-hero{flex-direction:column;align-items:stretch}.wbs-switch{align-self:flex-start}}
@media (prefers-reduced-motion:reduce){.we-tab,.wbs-source,.wbs-fit-card,.wbs-row button,.wbs-preview,.wbs-switch-track,.wbs-switch-track::before{transition:none}}
`;
export const WALLPAPER_CSS = CSS;
export function injectWallpaperStyles(): void {
  const id = 'dsh-wallpaper-engine/styles';
  const selector = `style[data-plugin-css="${id}"]`;
  const existing = document.querySelector<HTMLStyleElement>(selector);
  // 幂等但必须同步内容：HMR / bundle 重执行时组件会重建、<style> 标签却还在。
  // 旧实现直接 return ⇒ 改了 CSS 也永远注入不进去，表现为「新 DOM 没有新样式」。
  if (existing) {
    if (existing.textContent !== WALLPAPER_CSS) existing.textContent = WALLPAPER_CSS;
    return;
  }
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-wallpaper-engine';
  tag.dataset.pluginCss = id;
  tag.textContent = WALLPAPER_CSS;
  document.head.appendChild(tag);
}
