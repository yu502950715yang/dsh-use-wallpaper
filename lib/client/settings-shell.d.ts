export type SettingsTab = 'wallpaper' | 'boot';
export interface WallpaperSettingsShellProps {
    renderWallpaper?: () => JSX.Element;
    renderBoot?: () => JSX.Element;
}
export declare function WallpaperSettingsShell(props?: WallpaperSettingsShellProps): JSX.Element;
