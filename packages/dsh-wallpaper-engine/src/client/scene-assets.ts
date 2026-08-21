import type { SceneDescription } from '../shared/types.js';
import { parseSceneJson } from './scene-json.js';
import type { ParticleEmitterSpec, ParticleInitializerSpec } from './particles.js';

function vec3(s: unknown): [number, number, number] {
  if (typeof s !== 'string') return [0, 0, 0];
  const p = s.trim().split(/\s+/).map(Number);
  return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
}

export async function fetchSceneDescription(id: string): Promise<SceneDescription> {
  const resp = await fetch(`/wallpapers/scene/${id}/asset?name=scene.json`);
  if (!resp.ok) throw new Error('scene.json fetch failed');
  return parseSceneJson(await resp.text());
}

export function particlesFromSpec(root: any): { emitter: ParticleEmitterSpec; init: ParticleInitializerSpec } | null {
  if (typeof root !== 'object' || root === null) return null;
  const em = Array.isArray(root.emitter) ? root.emitter[0] : undefined;
  const inits = Array.isArray(root.initializer) ? root.initializer : [];
  if (!em) return null;
  const life = inits.find((i: any) => i.name === 'lifetimerandom');
  const size = inits.find((i: any) => i.name === 'sizerandom');
  const vel = inits.find((i: any) => i.name === 'velocityrandom');
  const color = inits.find((i: any) => i.name === 'colorrandom');
  const alpha = inits.find((i: any) => i.name === 'alpharandom');
  return {
    emitter: {
      // rate/distanceMax 缺省值对齐真实 WE 语义（linux-wallpaperengine 逆向源码：
      // rate=10、distancemax=256）；EVA Ashes 等 emitter 无 rate 字段，缺省 0 会导致永不发射
      rate: Number(em.rate ?? 10),
      directions: vec3(em.directions),
      distanceMin: Number(em.distancemin ?? 0),
      distanceMax: Number(em.distancemax ?? 256),
    },
    init: {
      lifetimeMin: Number(life?.min ?? 1),
      lifetimeMax: Number(life?.max ?? 1),
      sizeMin: Number(size?.min ?? 16),
      sizeMax: Number(size?.max ?? 16),
      velocityMin: vec3(vel?.min),
      velocityMax: vec3(vel?.max),
      colorMin: color ? vec3(color.min) : undefined,
      colorMax: color ? vec3(color.max) : undefined,
      alphaMin: alpha ? Number(alpha.min ?? 1) : undefined,
      alphaMax: alpha ? Number(alpha.max ?? 1) : undefined,
    },
  };
}

export async function fetchParticleSpec(id: string, assetName: string): Promise<{ emitter: ParticleEmitterSpec; init: ParticleInitializerSpec } | null> {
  const resp = await fetch(`/wallpapers/scene/${id}/asset?name=${encodeURIComponent(assetName)}`);
  if (!resp.ok) return null;
  return particlesFromSpec(JSON.parse(await resp.text()));
}
