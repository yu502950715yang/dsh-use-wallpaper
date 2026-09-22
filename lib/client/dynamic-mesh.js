// 动态网格（SceneScript 的 createModelData / createLayer / applyData）宿主侧实现。
//
// 数据形状（3798688689 实测）：vertexFormat = [POSITION, UV, COLOR]，stride = 9 floats/顶点
// （pos 3 + uv 2 + color 4），每 quad 4 顶点 = 36 floats、6 索引。
import * as THREE from 'three';
/** 本期只支持实测到的那一种组合；其余返回 null（调用方跳过该 mesh 并 warn 一次）。 */
export function resolveVertexLayout(vertexFormat) {
    if (!Array.isArray(vertexFormat) || vertexFormat.length !== 3)
        return null;
    if (vertexFormat[0] !== 0 || vertexFormat[1] !== 1 || vertexFormat[2] !== 2)
        return null;
    return { stride: 9, position: 0, uv: 3, color: 5 };
}
/**
 * 推断实际使用的 quad 数。
 *
 * 脚本不告知 count，但它用 `vertices.fill(0, count*36, previous*36)` 清尾、且 quad() 不会产出
 * 「四个顶点 position 全 0」的退化 quad ⇒ 取最后一个非空 quad 的下标 + 1。
 * ⚠️ 这是本模块唯一的启发式：若将来遇到不清尾的脚本（复用旧数据），要改为按 applyData 的
 * 参数长度推断。
 */
export function inferQuadCount(buffer, layout, capacity) {
    const quadFloats = layout.stride * 4;
    if (!(buffer instanceof Float32Array) || buffer.length < quadFloats)
        return 0;
    const cap = Math.min(capacity, Math.floor(buffer.length / quadFloats));
    let last = -1;
    for (let i = 0; i < cap; i++) {
        const base = i * quadFloats;
        for (let v = 0; v < 4; v++) {
            const o = base + v * layout.stride + layout.position;
            if (buffer[o] !== 0 || buffer[o + 1] !== 0) {
                last = i;
                break;
            }
        }
    }
    return last + 1;
}
/** 运行时网格注册表：脚本 createModelData → 几何体；createLayer → Mesh；applyData → 每帧写顶点。 */
export class DynamicMeshRegistry {
    parent;
    materialFor;
    onWarn;
    models = new Map();
    layers = new Map();
    /** 已解析完成的材质（按资产路径）。脚本 init 期就建层，而材质解析是异步的 ⇒ 必须支持回填。 */
    materialOverrides = new Map();
    nextModelId = 0;
    nextLayerId = 0;
    unsupported = 0;
    warnedUnsupported = false;
    constructor(opts) {
        this.parent = opts.parent;
        this.materialFor = opts.materialFor;
        this.onWarn = opts.onWarn ?? (() => { });
    }
    get modelCount() { return this.models.size; }
    get unsupportedCount() { return this.unsupported; }
    createModel(spec) {
        const layout = resolveVertexLayout(spec.vertexFormat);
        if (!layout) {
            this.unsupported++;
            if (!this.warnedUnsupported) {
                this.warnedUnsupported = true;
                this.onWarn(`动态网格：不支持的 vertexFormat ${JSON.stringify(spec.vertexFormat)}，已跳过该 mesh`);
            }
            return null;
        }
        const capacity = Math.max(0, Math.floor(spec.capacity));
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 4 * 3), 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(capacity * 4 * 2), 2));
        geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(capacity * 4 * 4), 4));
        // 每 quad 两个三角形；顶点数超 65535 才需要 Uint32 索引
        const IndexArray = capacity * 4 > 65535 ? Uint32Array : Uint16Array;
        const index = new IndexArray(capacity * 6);
        for (let i = 0; i < capacity; i++) {
            const a = i * 4, j = i * 6;
            index[j] = a;
            index[j + 1] = a + 1;
            index[j + 2] = a + 2;
            index[j + 3] = a;
            index[j + 4] = a + 2;
            index[j + 5] = a + 3;
        }
        geometry.setIndex(new THREE.BufferAttribute(index, 1));
        geometry.setDrawRange(0, 0);
        const id = this.nextModelId++;
        this.models.set(id, { capacity, layout, geometry, materialPath: spec.materialPath, count: 0 });
        return id;
    }
    createLayer(modelId, name) {
        const model = this.models.get(modelId);
        if (!model)
            return -1;
        const path = model.materialPath;
        const material = path
            ? (this.materialOverrides.get(path) ?? this.materialFor(path))
            : this.materialFor(null);
        const mesh = new THREE.Mesh(model.geometry, material);
        mesh.name = name;
        mesh.renderOrder = 1; // 背景（renderOrder 0）之上、与既有粒子同层
        mesh.frustumCulled = false; // 顶点每帧变且可能在相机外，剔除交给 drawRange
        this.parent.add(mesh);
        const id = this.nextLayerId++;
        this.layers.set(id, { modelId, mesh, visible: true });
        return id;
    }
    applyData(modelId, buffer) {
        const model = this.models.get(modelId);
        if (!model)
            return;
        if (!(buffer instanceof Float32Array))
            return;
        const { layout, capacity, geometry } = model;
        const quadFloats = layout.stride * 4;
        const count = Math.min(inferQuadCount(buffer, layout, capacity), capacity);
        const posAttr = geometry.getAttribute('position');
        const uvAttr = geometry.getAttribute('uv');
        const colAttr = geometry.getAttribute('color');
        const usable = Math.min(count, Math.floor(buffer.length / quadFloats));
        // 逐 quad 逐顶点解包：源数据交错（stride 9），目标三个 attribute 是分离的平面数组
        for (let i = 0; i < usable; i++) {
            for (let v = 0; v < 4; v++) {
                const src = i * quadFloats + v * layout.stride;
                const dst = i * 4 + v;
                posAttr.array[dst * 3] = buffer[src + layout.position];
                posAttr.array[dst * 3 + 1] = buffer[src + layout.position + 1];
                posAttr.array[dst * 3 + 2] = buffer[src + layout.position + 2];
                uvAttr.array[dst * 2] = buffer[src + layout.uv];
                uvAttr.array[dst * 2 + 1] = buffer[src + layout.uv + 1];
                colAttr.array[dst * 4] = buffer[src + layout.color];
                colAttr.array[dst * 4 + 1] = buffer[src + layout.color + 1];
                colAttr.array[dst * 4 + 2] = buffer[src + layout.color + 2];
                colAttr.array[dst * 4 + 3] = buffer[src + layout.color + 3];
            }
        }
        if (usable > 0) {
            // 只标记实际使用区间 → 上传 114 KB/帧而不是全量 1.79 MB
            markRange(posAttr, usable * 4 * 3);
            markRange(uvAttr, usable * 4 * 2);
            markRange(colAttr, usable * 4 * 4);
        }
        geometry.setDrawRange(0, usable * 6);
        model.count = usable;
    }
    /**
     * 材质解析完成后回填：替换**所有已建**（以及后续新建）mesh 上该路径的材质。
     *
     * 必须支持回填 —— 脚本在 init 期就调 createLayer，而材质 json 与 .tex 的解码是异步的，
     * 早于它不可能完成；没有这条通道，所有网格都会永久停在兜底白图材质上（真机现象：
     * 粒子渲染成一堆硬边白色方块）。
     */
    setMaterialForPath(materialPath, material) {
        this.materialOverrides.set(materialPath, material);
        for (const layer of this.layers.values()) {
            const model = this.models.get(layer.modelId);
            if (model?.materialPath === materialPath)
                layer.mesh.material = material;
        }
    }
    setVisible(layerId, visible) {
        const layer = this.layers.get(layerId);
        if (!layer)
            return;
        layer.visible = visible;
        layer.mesh.visible = visible;
    }
    isVisible(layerId) {
        return this.layers.get(layerId)?.visible ?? false;
    }
    geometryOf(modelId) {
        return this.models.get(modelId)?.geometry ?? null;
    }
    meshOf(layerId) {
        return this.layers.get(layerId)?.mesh ?? null;
    }
    dispose() {
        for (const layer of this.layers.values()) {
            this.parent.remove(layer.mesh);
            // 材质由 materialFor 提供、可能被多个 mesh 共享 → 这里只释放几何体
        }
        this.layers.clear();
        for (const model of this.models.values())
            model.geometry.dispose();
        this.models.clear();
    }
}
/** 清空并写入 updateRange（three r170：updateRanges 数组 + clearUpdateRanges）。 */
function markRange(attr, count) {
    attr.clearUpdateRanges();
    attr.addUpdateRange(0, count);
    attr.needsUpdate = true;
}
