import type { SceneDescription } from '../shared/types.js';
export declare function parseSceneJson(raw: string): SceneDescription;
/**
 * 把 resolveSceneUserBindings 后的 color/alpha/brightness 写回原始 scene.json 文本。
 * loadSceneToThree 会重新 parseSceneJson，颜色必须写 0-1 字符串，避免 optColor 二次 ×255。
 */
export declare function sceneJsonWithResolvedModulation(sceneJson: string, desc: SceneDescription): string;
