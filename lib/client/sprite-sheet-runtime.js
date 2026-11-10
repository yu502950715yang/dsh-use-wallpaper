export class SpriteSheetRuntime {
    layers = new Map();
    register(backgroundId, objectId, mesh, sprite) {
        const attr = mesh.geometry.attributes?.uv;
        const layer = {
            backgroundId,
            mesh,
            frames: Math.max(1, Math.floor(sprite.frames)),
            cols: Math.max(1, Math.floor(sprite.cols)),
            rows: Math.max(1, Math.floor(sprite.rows)),
            elapsed: 0,
            // 帧率 = 首帧 frametime 的倒数（缺省 1fps）；clamp 0.1–240 防畸形素材把动画打飞。
            fps: sprite.frametime && sprite.frametime > 0
                ? Math.min(240, Math.max(0.1, 1 / sprite.frametime))
                : 1,
            frame: -1,
            paused: false,
            baseUv: attr ? Float32Array.from(attr.array) : new Float32Array(0),
            uv: { u0: 0, v0: 0, u1: 1, v1: 1 },
        };
        this.layers.set(objectId, layer);
        this.applyFrame(layer, 0);
    }
    // 写当前帧子矩形：frame 按**行优先**（col = frame % cols，row = floor(frame / cols)）。
    // v 方向：tex-loader 显示约定 v=0=图像底部，而 TEXS 的 row 0 = 表顶行 ⇒ 第 0 行落在高 v 段
    //（与粒子 shader 的 (rows-1-row) 同源）；帧内 v 继续沿用 quad 原始 0/1 取向，不额外翻转。
    applyFrame(layer, frame) {
        const { cols, rows } = layer;
        const col = ((frame % cols) + cols) % cols;
        const row = Math.floor(frame / cols) % rows;
        const u0 = col / cols;
        const u1 = (col + 1) / cols;
        const v0 = (rows - 1 - row) / rows;
        const v1 = (rows - row) / rows;
        const attr = layer.mesh.geometry.attributes?.uv;
        if (attr) {
            const arr = attr.array;
            const base = layer.baseUv;
            for (let i = 0; i < arr.length && i < base.length; i += 2) {
                arr[i] = u0 + base[i] * (u1 - u0);
                arr[i + 1] = v0 + base[i + 1] * (v1 - v0);
            }
            attr.needsUpdate = true;
        }
        layer.frame = frame;
        layer.uv = { u0, v0, u1, v1 };
    }
    // 逐帧推进精灵表动画：dt 累加（不跟墙钟，暂停/回退不跳帧），帧号 = floor(elapsed × fps) % frames。
    update(dt) {
        if (this.layers.size === 0)
            return;
        const step = Number.isFinite(dt) && dt > 0 ? dt : 0;
        for (const layer of this.layers.values()) {
            if (layer.paused)
                continue; // 脚本 pause 后停住；play 恢复
            layer.elapsed += step;
            const frame = Math.floor(layer.elapsed * layer.fps) % layer.frames;
            if (frame !== layer.frame)
                this.applyFrame(layer, frame);
        }
    }
    // resizeBackground：换几何后 UV 是整图 [0,1]² ⇒ 以它为新的 base 并立即重写当前帧子矩形。
    rebaseForBackground(backgroundId) {
        for (const layer of this.layers.values()) {
            if (layer.backgroundId !== backgroundId)
                continue;
            const attr = layer.mesh.geometry.attributes?.uv;
            layer.baseUv = attr ? Float32Array.from(attr.array) : new Float32Array(0);
            this.applyFrame(layer, Math.max(0, layer.frame));
        }
    }
    // ── 脚本的纹理动画控制（thisLayer.getTextureAnimation → 这里）；未登记 id 一律安全 no-op ──
    pause(objectId) {
        const layer = this.layers.get(objectId);
        if (layer)
            layer.paused = true;
    }
    play(objectId) {
        const layer = this.layers.get(objectId);
        if (layer)
            layer.paused = false;
    }
    /** 停播并回到第 0 帧（对齐 AnimPlayback.stop 的语义）。 */
    stop(objectId) {
        const layer = this.layers.get(objectId);
        if (!layer)
            return;
        layer.paused = true;
        layer.elapsed = 0;
        this.applyFrame(layer, 0);
    }
    isPlaying(objectId) {
        return this.layers.get(objectId)?.paused === false;
    }
    /** 立即写 UV（越界钳到 [0, frames-1]）；同时把 elapsed 对齐到该帧，play 后从这里继续。 */
    setFrame(objectId, frame) {
        const layer = this.layers.get(objectId);
        if (!layer)
            return;
        const f = Number.isFinite(frame)
            ? Math.min(layer.frames - 1, Math.max(0, Math.trunc(frame)))
            : 0;
        layer.elapsed = layer.fps > 0 ? f / layer.fps : 0;
        this.applyFrame(layer, f);
    }
    getFrame(objectId) {
        return this.layers.get(objectId)?.frame ?? -1;
    }
    /** 测试用：取精灵表图层当前帧的 UV 子矩形（仅测试/诊断观测，不参与渲染）。 */
    uvForTest(objectId) {
        const layer = this.layers.get(objectId);
        return layer ? { ...layer.uv } : null;
    }
    clear() {
        this.layers.clear();
    }
}
