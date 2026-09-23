const CSS = `
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
}
body[data-ds-dark-theme]{
  --wp-panel-bg:rgba(20,22,28,.92);
  --wp-panel-border:rgba(255,255,255,.12);
  --wp-text:#eee;
  --wp-badge-bg:rgba(0,0,0,.65);
  --wp-badge-fg:#fff;
  --wp-accent:#4f8cff;
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
  /* 弹层菜单底（指令菜单 / 模型选择 / 任务菜单等 8 个包共用）：0.1.7 把它从
     var(--dsw-alias-bg-layer-3)（不透明）改成 #f8f9fa94 + blur(40px) 的玻璃，壁纸透上来后
     文字发虚 ⇒ 有壁纸时压回接近不透明（浅 .92 / 深 .94）。 */
  --dsw-specific-menu:rgba(255,255,255,.92)!important;
}
/* 深色分支：气泡回 DSH 原生底色（深蓝实心），壁纸被气泡遮住；仅 message 容器透明。
   同浅色注释：2026-08-31 起 --dsw-specific-bubble 不再设 transparent */
body[data-ds-dark-theme][data-we-wallpaper]{
  --dsw-specific-input-major:transparent;
  /* --dsw-specific-bubble:transparent;  ← 移除，回 DSH 原生底色 */
  /* 深色：侧边栏根填充分支（同浅色注释），暗色半透明让壁纸透出 */
  --dsw-specific-sidebar-fill:rgba(24,26,30,.4)!important;
  /* 弹层菜单底：同浅色分支注释（0.1.7 的深色值 #30313680 α≈.5 同样过透） */
  --dsw-specific-menu:rgba(24,26,30,.94)!important;
}

/* ── 消息气泡（flowItem）回 DSH 原生样式（2026-08-31 决策） ──
   此前插件给[class*="flowItem"]叠加了液态玻璃（blur + 半透明 + 圆角 + 内高光），
   让气泡浮在壁纸上。现按用户要求改回 DSH 原生气泡 —— 移除本覆盖后，气泡使用
   DSH 默认不透明深蓝底色（--dsw-specific-bubble 已在上方分支移除 transparent），
   壁纸会被气泡挡住（原生气泡的正常观感）。
   注意：只移除气泡（flowItem），底部输入框（data-composer-card）与提问弹窗
   （data-question-key）保留插件液态玻璃，不动。 ── */

/* ── 仅输入框（data-composer-card）与提问弹窗（data-question-key）保留液态玻璃；
   消息气泡（flowItem）已改回 DSH 原生（见上方注释），不再被覆盖。 ── */
body[data-we-wallpaper] [data-composer-card]{
  border-radius:20px;
  background-color:rgba(255,255,255,.5);
  background-image:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.05) 38%,rgba(255,255,255,.02));
  -webkit-backdrop-filter:blur(14px) saturate(1.7);
  backdrop-filter:blur(14px) saturate(1.7);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4),inset 0 -1px 0 rgba(255,255,255,.08),0 4px 16px rgba(0,0,0,.1);
}
body[data-ds-dark-theme][data-we-wallpaper] [data-composer-card]{
  background-color:rgba(24,26,30,.65);
  background-image:linear-gradient(180deg,rgba(255,255,255,.06),rgba(255,255,255,.02) 38%,rgba(255,255,255,.03));
}
/* 用户提问弹窗（ask_user_question）：其卡片（Mbwy4a_card）原为 transparent，与主输入框
   （data-composer-card）不一致——套用同一液态玻璃统一视觉（2026-08-25）。
   [data-question-key] 是 DSH user-question 组件外层 frame 的稳定属性。 */
body[data-we-wallpaper] [data-question-key] section{
  border-radius:20px;
  background-color:rgba(255,255,255,.5);
  background-image:linear-gradient(180deg,rgba(255,255,255,.18),rgba(255,255,255,.05) 38%,rgba(255,255,255,.02));
  -webkit-backdrop-filter:blur(14px) saturate(1.7);
  backdrop-filter:blur(14px) saturate(1.7);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.4),inset 0 -1px 0 rgba(255,255,255,.08),0 4px 16px rgba(0,0,0,.1);
}
body[data-ds-dark-theme][data-we-wallpaper] [data-question-key] section{
  background-color:rgba(24,26,30,.65);
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

/* ── 设置对话框 "壁纸" 面板（settings-section，用 DSH 主题变量） ── */
.wss-root{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary,var(--wp-text));font-size:13px}
.wss-hint{color:var(--dsw-alias-label-secondary,var(--wp-text));margin:0;font-size:12px;line-height:1.6}
.wss-current{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px}
.wss-current-actions{display:flex;gap:8px}
.wss-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px;max-height:280px;overflow-y:auto;padding:2px}
.wss-thumb{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px;background:var(--dsw-alias-bg-layer-3,transparent);border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));border-radius:10px;cursor:pointer;color:var(--dsw-alias-label-primary,var(--wp-text));font:inherit;min-width:0}
.wss-thumb img{width:84px;height:84px;object-fit:cover;border-radius:8px;display:block}
.wss-thumb .wss-no-preview{width:84px;height:84px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:var(--dsw-alias-bg-module-platform,rgba(0,0,0,.08));font-size:11px;color:var(--dsw-alias-label-tertiary,var(--wp-text))}
.wss-thumb-title{font-size:12px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wss-thumb.wss-selected{border-color:var(--wp-accent);box-shadow:0 0 0 1px var(--wp-accent)}
.wss-badge{position:absolute;top:2px;right:2px;font-size:9px;line-height:1;padding:2px 4px;border-radius:4px;background:var(--wp-badge-bg);color:var(--wp-badge-fg)}
.wss-cancel,.wss-save-dirs,.wss-probe,.wss-adopt,.wss-refresh{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;padding:6px 12px;font:inherit;font-size:12px;cursor:pointer}
.wss-cancel:hover,.wss-save-dirs:hover,.wss-probe:hover,.wss-adopt:hover,.wss-refresh:hover{filter:brightness(1.08)}
.wss-dirs h4{margin:10px 0 6px;font-size:13px}
.wss-dir-row{display:flex;flex-direction:column;gap:4px;margin-bottom:8px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-dir-row input{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;padding:6px 10px;font:inherit;font-size:12px}
/* 光晕开关行：复选框与文字与其他控件（.wss-dir-row）左对齐、同一行居中 */
.wss-glow-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
/* 光晕阈值/强度滑杆：标签与滑杆竖排，滑杆占满宽度 */
.wss-glow{display:flex;flex-direction:column;gap:2px;margin:4px 0 10px}
.wss-glow-slider{display:flex;flex-direction:column;gap:2px;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-glow-slider input[type=range]{width:100%;margin:0}
/* 省电/画质档位区块：复用光晕行的排版，行距更紧 */
.wss-power{display:flex;flex-direction:column;gap:2px;margin:4px 0 10px}
.wss-quality{border:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));background:var(--dsw-alias-bg-layer-3,var(--wp-panel-bg));color:var(--dsw-alias-label-primary,var(--wp-text));border-radius:8px;padding:4px 8px;font:inherit;font-size:12px}
.wss-dir-actions{display:flex;gap:8px}
.wss-probe-result{border-top:1px solid var(--dsw-alias-border-l2,var(--wp-panel-border));padding-top:10px;margin-top:4px}
.wss-candidate{display:flex;align-items:center;gap:8px;padding:4px 0}
.wss-candidate-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}
.wss-exists{color:var(--dsw-alias-state-success-primary,#4caf50);font-size:11px;white-space:nowrap}
.wss-missing{color:var(--dsw-alias-label-tertiary,var(--wp-text));font-size:11px;white-space:nowrap}
.wss-message{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary,var(--wp-text))}

/* ── 文字颜色跟随壁纸亮度（2026-09-03 定稿） ──
   不遮背景、不改壁纸可见度；只让消息列（[class*="flowItem"] 内主要文本）的
   文字颜色跟随壁纸亮度自动切换：暗壁纸→白字、亮壁纸→黑字。颜色经 --wp-chat-fg
   变量（background-layer.js setChatFg 写），fallback 到 DSH 主题文字色（未测量时）。
   选择器用 flowItem 子元素（稳，不依赖 DSH 的 CSS module 哈希类）。
   ⚠ code（行内代码）有独立不透明背景（浅色近白 --dsw-alias-markdown-inline-code），
   其文字必须用与背景对比的 DSH 主题色（--dsw-alias-label-primary：浅=黑/深=白），
   不能被 --wp-chat-fg 反色——否则暗壁纸下父级变白字，code 继承成白字白底。
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
}
/* 聊天顶部 header（会话标题栏 wSkVaW_header / headerActions / headerUtilities）：
   背景透明贴壁纸，文字/图标用固定深灰 → 暗壁纸下看不清。跟随 --wp-chat-fg 反色。
   ChatHeader 组件类（wSkVaW_header 前缀），其操作图标 fill="currentColor" 继承容器 color。 */
body[data-we-wallpaper] [class*="wSkVaW_header"],
body[data-we-wallpaper] [class*="wSkVaW_header"] *{
  color:var(--wp-chat-fg,var(--dsw-alias-label-primary,inherit));
}
/* li 列表点（::marker）：DSH 给 marker 单独设深灰（--dsw-alias-label-secondary），
   覆盖了继承；li 文本已跟随 --wp-chat-fg 但点仍是深灰 → 暗壁纸下看不清。
   让 marker 同样跟随 --wp-chat-fg 反色。 */
body[data-we-wallpaper] [class*="flowItem"] li::marker{
  color:var(--wp-chat-fg,var(--dsw-alias-label-primary,inherit));
}
/* 行内代码/代码块：显式主题色（覆盖父级继承的 --wp-chat-fg），保证与其背景对比正确 */
body[data-we-wallpaper] [class*="flowItem"] code,
body[data-we-wallpaper] [class*="flowItem"] pre code{
  color:var(--dsw-alias-label-primary,inherit);
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
`;
export const WALLPAPER_CSS = CSS;
export function injectWallpaperStyles(): void {
  const id = 'dsh-wallpaper-engine/styles';
  if (document.querySelector(`style[data-plugin-css="${id}"]`)) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-wallpaper-engine';
  tag.dataset.pluginCss = id;
  tag.textContent = WALLPAPER_CSS;
  document.head.appendChild(tag);
}
