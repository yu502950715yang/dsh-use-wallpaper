export type BackgroundPlan = {
    kind: 'image';
    url: string;
    kenBurns: boolean;
} | {
    kind: 'video';
    url: string;
} | {
    kind: 'scene';
    wallpaperId: string;
} | {
    kind: 'web';
    url: string;
} | {
    kind: 'none';
};
export interface ClientSettings {
    selectedWallpaperId: string;
    wallpaperDir: string;
    weAssetsDir: string;
    overlayOpacity: number;
    blurEnabled: boolean;
    blurRadius: number;
    kenBurns: boolean;
    /** 应用级 Glow（对齐 WE 的 general.user.postprocessing）：整帧亮部发光。 */
    glowEnabled: boolean;
    /** bright-pass 阈值（sRGB 域），缺省 0.75。 */
    glowThreshold: number;
    /** 发光强度，缺省 0.4。 */
    glowStrength: number;
    /** 手动暂停壁纸渲染（省电；scene 与视频壁纸生效）。 */
    paused: boolean;
    /** 页面切到后台（不可见）时自动暂停，回来恢复。 */
    pauseOnHidden: boolean;
    /** 画质档位：渲染像素比倍率（1 = 原生 dpr；0.5 = 半分辨率省显存/提流畅）。 */
    qualityScale: number;
    /** 壁纸音效（sound 对象播放）并驱动音频频谱效果；缺省 true（对齐桌面 WE）。 */
    soundEnabled: boolean;
    /** 贴壁纸文字颜色模式：auto（跟随壁纸亮度，默认）/ white / black / custom。
     *  宽松 string —— 远端值可能来自别的版本，由 text-color.normalizeMode 归一为 auto。 */
    textColorMode: string;
    /** 自定义文字颜色（#rgb / #rrggbb），仅 custom 档使用；非法值由 text-color 回退白色。 */
    textColor: string;
    /** 文字描边档位：0 = 关（默认）；1-3 递增（对立色阴影，背景花哨时的兜底层）。 */
    textOutline: number;
}
