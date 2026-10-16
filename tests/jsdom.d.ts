// jsdom@25 无自带类型、仓库未装 @types/jsdom：只补本仓库测试用到的最小面（构造 + window）。
declare module 'jsdom' {
  export class JSDOM {
    constructor(html?: string, options?: Record<string, unknown>);
    readonly window: any;
  }
  export class VirtualConsole {
    on(event: string, handler: (...args: any[]) => void): void;
  }
}
