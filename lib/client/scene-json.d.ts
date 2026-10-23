import type { SceneDescription } from '../shared/types.js';
export declare function parseSceneJson(raw: string): SceneDescription;
/**
 * 把 resolveSceneUserBindings 后的 color/alpha/brightness 写回原始 scene.json 文本。
 * loadSceneToThree 会重新 parseSceneJson，颜色必须写 0-1 字符串，避免 optColor 二次 ×255。
 * 不变量：player 侧能消费的可绑定字段必须在此写回（或经 SceneAssets 显式下发——origin/scale/
 * angles 走 worldTransforms、visible 走 effectiveVisible）；新增消费字段时先补这条路，否则静默用作者值。
 */
export declare function sceneJsonWithResolvedModulation(sceneJson: string, desc: SceneDescription): string;
