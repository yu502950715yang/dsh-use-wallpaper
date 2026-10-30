import * as THREE from 'three';
export interface MediaThumbnailTextureSource {
    readonly texture: THREE.Texture;
    hasImage(): boolean;
    setImage(image: ImageBitmap | null): void;
    dispose(): void;
}
export declare function createMediaThumbnailTextureSource(): MediaThumbnailTextureSource;
