import { coverRange } from './object-range.js';
const FULL_UV_COVER = { sx: 0, sy: 0, sw: 1, sh: 1 };
function sameCover(a, b) {
    return a.sx === b.sx && a.sy === b.sy && a.sw === b.sw && a.sh === b.sh;
}
export class UtilContentRuntime {
    entries = new Map();
    /** 登记 util 内容条目（内容 mesh 与快照内容区域的世界锚点）；solid 不登记（纯色内容不被替换）。 */
    register(objectId, mesh, centerX, centerY) {
        const uv = mesh.geometry.attributes?.uv;
        if (!uv)
            return;
        this.entries.set(objectId, {
            mesh,
            baseUv: Float32Array.from(uv.array),
            cover: FULL_UV_COVER,
            texture: null,
            centerX,
            centerY,
        });
    }
    setTexture(objectId, texture, opts = {}) {
        const entry = this.entries.get(objectId);
        if (!entry)
            return;
        const material = entry.mesh.material;
        let changed = false;
        if (material.map !== texture) {
            material.map = texture;
            material.opacity = 1; // 透明占位 → 快照内容
            material.needsUpdate = true; // 无 map → 有 map：需重编 program（每次装配仅一次）
            entry.texture = texture;
            changed = true;
        }
        const cover = opts.cover ?? FULL_UV_COVER;
        if (changed || !sameCover(entry.cover, cover))
            this.applyCover(entry, cover);
    }
    /** 测试/诊断：util 内容当前纹理；solid / 非 util → null。 */
    textureForTest(objectId) {
        return this.entries.get(objectId)?.texture ?? null;
    }
    /** 测试/诊断：util 内容当前的快照覆盖矩形（内容 mesh UV 空间）。 */
    uvForTest(objectId) {
        const cover = this.entries.get(objectId)?.cover;
        return cover ? { ...cover } : null;
    }
    has(objectId) {
        return this.entries.has(objectId);
    }
    clear() {
        this.entries.clear();
    }
    // 快照覆盖矩形 = 主相机 cover 视锥（世界，中心 = 场景中心，与 applyCover 同源）在内容 mesh
    // UV 空间的反解：u_tex = (u - sx)/sw。世界尺寸取**当前** mesh.scale × 几何（含镜像负值）。
    coverFor(objectId, view) {
        const entry = this.entries.get(objectId);
        if (!entry)
            return null;
        const geometry = entry.mesh.geometry;
        const gw = geometry.parameters?.width ?? 0;
        const gh = geometry.parameters?.height ?? 0;
        const worldW = entry.mesh.scale.x * gw;
        const worldH = entry.mesh.scale.y * gh;
        if (!(Math.abs(worldW) > 1e-6) || !(Math.abs(worldH) > 1e-6))
            return null;
        const cover = coverRange(view.sceneWidth, view.sceneHeight, view.viewWidth / view.viewHeight);
        const left = entry.centerX - worldW / 2;
        const bottom = entry.centerY - worldH / 2;
        return {
            sx: (-cover.w / 2 - left) / worldW,
            sy: (-cover.h / 2 - bottom) / worldH,
            sw: cover.w / worldW,
            sh: cover.h / worldH,
        };
    }
    // 按覆盖矩形重写内容几何 UV（uv' = (uv - sx)/sw）：v=0 = 画面底 ⇒ 快照 v 约定不额外翻转。
    applyCover(entry, cover) {
        entry.cover = cover;
        const uv = entry.mesh.geometry.attributes?.uv;
        if (!uv)
            return;
        const arr = uv.array;
        const rx = 1 / cover.sw;
        const ry = 1 / cover.sh;
        const ox = -cover.sx / cover.sw;
        const oy = -cover.sy / cover.sh;
        for (let i = 0; i < arr.length && i < entry.baseUv.length; i += 2) {
            arr[i] = entry.baseUv[i] * rx + ox;
            arr[i + 1] = entry.baseUv[i + 1] * ry + oy;
        }
        uv.needsUpdate = true;
    }
}
