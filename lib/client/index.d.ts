declare global {
    interface Window {
        __ModuleLoader__?: any;
        __DSH_BOOT__?: any;
    }
}
export declare function bootstrap(ctx?: any): void;
export declare function apply(ctx: any): void;
export declare const inject: string[];
