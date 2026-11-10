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
export declare function checkEnvironment(input: EnvCheckInput): EnvIssue[];
/** 浏览器能力探测：无 DOM（node 测试/SSR）时返回 null（不判定）。 */
export declare function detectWebGL2(): boolean | null;
