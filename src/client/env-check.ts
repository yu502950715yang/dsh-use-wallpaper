// 环境自检：面板「实时渲染」卡用它给用户可自救的提示（1.0 可观测性）。
// 纯函数 + 独立探测，便于 node/jsdom 单测；只提示、不修复。

export type EnvIssueKey = 'webgl2' | 'we-assets' | 'web-fallback';
export type EnvIssueTone = 'warn' | 'info';

export interface EnvIssue {
  key: EnvIssueKey;
  tone: EnvIssueTone;
  text: string;
}

export interface EnvCheckInput {
  /** 浏览器是否支持 WebGL2；null = 无法判定（不误报） */
  hasWebGL2: boolean | null;
  /** WE 引擎目录配置值（空字符串 = 未配置） */
  weAssetsDir: string;
  /** 当前壁纸类型；null = 未选壁纸 */
  currentKind: string | null;
}

/** 三类环境问题的判定（顺序 = 面板展示顺序）。 */
export function checkEnvironment(input: EnvCheckInput): EnvIssue[] {
  const issues: EnvIssue[] = [];
  if (input.hasWebGL2 === false) {
    issues.push({
      key: 'webgl2',
      tone: 'warn',
      text: '当前浏览器不支持 WebGL2：scene 壁纸会回退预览图，建议改用 Chrome / Edge。',
    });
  }
  if (!input.weAssetsDir) {
    issues.push({
      key: 'we-assets',
      tone: 'warn',
      text: '未配置 Wallpaper Engine 安装目录：粒子与特效纹理将退化为纯色点，请在下方目录设置里填写或点「自动探测」。',
    });
  }
  if (input.currentKind === 'web') {
    issues.push({
      key: 'web-fallback',
      tone: 'info',
      text: '网页壁纸失败时无法自动回退（跨源限制），画面可能停在空白；可先切换其它壁纸。',
    });
  }
  return issues;
}

/** 浏览器能力探测：无 DOM（node 测试/SSR）时返回 null（不判定）。 */
export function detectWebGL2(): boolean | null {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    return !!canvas.getContext('webgl2');
  } catch {
    return false;
  }
}
