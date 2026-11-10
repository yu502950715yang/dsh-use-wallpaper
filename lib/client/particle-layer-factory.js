// 粒子图层装配与逐帧刷新：从 ThreeScenePlayer 拆出的阶段 2c-2b 子系统（审查 P0-9）。
// 装配（addParticle）通过 host 注入图层簿记/隔离装配/段边界登记；逐帧刷新（updateParticles/
// writeParticleData）是纯数据写入。不 import player（ParticleLayer 类型由本文件拥有）。
import * as THREE from 'three';
import { PARTICLE_QUAD_CORNERS, PARTICLE_QUAD_INDEX, PARTICLE_VERTEX_SHADER, PARTICLE_FRAGMENT_SHADER, PARTICLE_FLOATS_PER_INSTANCE, particleCapacity, simEmitterOffset, textureTexelRatio, particlePerspMatrix, } from './particle-assets.js';
import { createWhiteTexture } from './layer-material-factory.js';
export function addParticle(host, simVerticesGetter, opts) {
    const frameCount = Math.max(1, Math.floor(opts.frameCount));
    // 网格列/行：缺省横向等分（cols=frameCount、rows=1）；精灵表由调用方按纹理元数据给出，
    // 非法值回退缺省（防御越界 spec/纹理）。
    const frameCols = Number.isFinite(opts.frameCols) && opts.frameCols > 0
        ? Math.max(1, Math.floor(opts.frameCols))
        : frameCount;
    const frameRows = Number.isFinite(opts.frameRows) && opts.frameRows > 0
        ? Math.max(1, Math.floor(opts.frameRows))
        : 1;
    // softness 缺省按有无纹理对齐 wasm `particle_billboard` 的 mask_mode：有纹理 → 0.15（mask_mode=1
    // 时形状由 texel.a 提供、softness 不参与，仅作兜底）；无纹理（1×1 白图兜底）→ 1.0（整盘软圆点）。
    // 缺省不能是 0 —— 那会让无纹理粒子变成**硬边白方块**。调用方显式传值时以其为准。
    const hasTex = !!opts.tex;
    const softness = opts.softness ?? (hasTex ? 0.15 : 1.0);
    // 折射门槛：隔离层渲染进对象 RT，其裁剪空间 ≠ 屏幕 UV ⇒ 不启用 REFRACT（等价 WE 的「不折射」）；
    // amount 非法回落 WE 缺省 0.05。
    const refractEnabled = !!opts.refract && !opts.isolate;
    const refractAmount = Number.isFinite(opts.refract?.amount) ? opts.refract.amount : 0.05;
    // InstancedBufferGeometry：基础 4 角点四边形（position）+ 索引；每粒子一个实例（instanced 属性）。
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(PARTICLE_QUAD_CORNERS, 3));
    geometry.setIndex(new THREE.BufferAttribute(new Uint16Array(PARTICLE_QUAD_INDEX), 1));
    geometry.instanceCount = 0;
    // 初始 getter 数据 → 首帧写入（容量固定，见下）。
    const initial = simVerticesGetter();
    const count = Math.floor(initial.length / PARTICLE_FLOATS_PER_INSTANCE);
    // ⚠️ 实例缓冲容量必须**一次给足、之后不再替换属性**：three r170 在 `setupVertexAttributes` 里
    // 对 InstancedBufferGeometry **只锁存一次**容量（three.module.js L15653-15657，`undefined` 判断
    // ⇒ 属性怎么变都不再更新，只有 `geometry.dispose()` 会清掉）：
    //   `geometry._maxInstanceCount = geometryAttribute.meshPerAttribute * geometryAttribute.count`
    // 绘制时取 `Math.min(geometry.instanceCount, geometry._maxInstanceCount)`（L29764-29767），而
    // `renderInstances` 首行是 `if (primcount === 0) return;`（L15861-15863）—— 计数 0 时**不画**。
    // 建层时模拟器还没推进，getter 返回 0 粒子：照粒子数分配属性（0 长度）会把容量锁存成 0 ⇒ 该层
    // **永远不画**（「背景清晰但没有粒子」）；首帧恰好 1 个粒子则锁死 1 ⇒ 永远只画 1 个粒子。
    // 故按 sim 的 maxcount（`opts.maxInstances`，缺省 DEFAULT_PARTICLE_CAPACITY）**预分配**全部
    // instanced 属性，运行期只改 `geometry.instanceCount`（0..capacity）。
    const capacity = particleCapacity(opts.maxInstances ?? 0, count);
    // per-particle（每个实例）属性：pos(3)/size(1)/uv(2)/color(3)/alpha(1)；itemSize 与字段对应。
    const positions = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const sizes = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const uvs = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 2), 2);
    const colors = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const alphas = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    const rots = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    const velocities = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    geometry.setAttribute('particlePosition', positions);
    geometry.setAttribute('particleSize', sizes);
    geometry.setAttribute('particleUv', uvs);
    geometry.setAttribute('particleColor', colors);
    geometry.setAttribute('particleAlpha', alphas);
    geometry.setAttribute('particleRot', rots);
    geometry.setAttribute('particleVelocity', velocities);
    // ShaderMaterial：billboard quad（pos + corner*half_size）+ 多帧 uv 切片 + additive/alpha blend；
    // maskMode：有纹理→1（形状由 texel.a 提供）；无纹理白图兜底→0（软圆盘），对齐 wasm particle_billboard。
    const material = new THREE.ShaderMaterial({
        uniforms: {
            map: { value: opts.tex ?? createWhiteTexture() },
            frameCount: { value: frameCount },
            frameCols: { value: frameCols },
            frameRows: { value: frameRows },
            softness: { value: softness },
            maskMode: { value: hasTex ? 1.0 : 0.0 },
            // 折射 uniform 只给折射层（非折射层连 uniform 都不建：零开销、零分歧）。refractBg 缺省
            // 1×1 白 = 不做位移（快照由段渲染在消费者绘制前写入）。
            ...(refractEnabled
                ? {
                    refractNormal: { value: opts.refract.normalTex },
                    refractBg: { value: createWhiteTexture() },
                    refractAmount: { value: refractAmount },
                }
                : {}),
            // 对象变换（缺省恒等 → 顶点 shader 退化为旧的 worldPos = particlePosition + corner*size/2）。
            objCenter: { value: new THREE.Vector3(...(opts.objectCenter ?? [0, 0, 0])) },
            objScale: { value: new THREE.Vector3(...(opts.objectScale ?? [1, 1, 1])) },
            objAngles: { value: new THREE.Vector3(...(opts.objectAngles ?? [0, 0, 0])) },
            emitterOrigin: { value: new THREE.Vector3(...(opts.emitterOrigin ?? [0, 0, 0])) },
            bmOffset: { value: new THREE.Vector3(...simEmitterOffset(opts.emitterOrigin ?? [0, 0, 0])) },
            // spritetrail（缺省关闭 → 顶点 shader 走原旋转分支，既有壁纸逐像素不变）。
            trailEnabled: { value: opts.trail ? 1.0 : 0.0 },
            trailParams: {
                value: new THREE.Vector3(opts.trail?.length ?? 1, opts.trail?.maxLength ?? 1, opts.trail?.minLength ?? 0),
            },
            texelRatio: { value: textureTexelRatio(opts.tex) },
            // 粒子透视相机（缺省关闭 → 走主正交投影，既有壁纸逐像素不变）。
            perspEnabled: { value: opts.perspective ? 1.0 : 0.0 },
            persp: { value: particlePerspMatrix(opts.perspective) },
            perspEye: { value: new THREE.Vector3(0, 0, opts.perspective?.distance ?? 0) },
            // 对象级视差的世界平移（逐帧由 tickParallax 写；0 = 与加视差前逐像素相同）。
            u_Parallax: { value: new THREE.Vector2(0, 0) },
        },
        vertexShader: PARTICLE_VERTEX_SHADER,
        fragmentShader: PARTICLE_FRAGMENT_SHADER,
        // three 的 define 进 program cache key：非折射层的 program 与改动前完全同源（仅在折射时
        // 给 defines 键 —— 显式 undefined 会被 Material 构造器告警刷屏）。
        ...(refractEnabled ? { defines: { REFRACT: 1 } } : {}),
        transparent: true,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: opts.blend === 'additive' ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geometry, material);
    // 粒子散布在场景（非基础四边形包围球），禁用视锥剔除防止对象中心离屏时整层消失。
    mesh.frustumCulled = false;
    // 双保险：`InstancedBufferGeometry.computeBoundingSphere()` 只看**基础四边形**（半径≈1.4）而
    // **不看** per-instance 位置，任何仍按 boundingSphere 剔除的代码路径（未来重构、旧 three 版本、
    // 自定义 renderer/WebXR）都会把整层判为「离屏」（粒子在世界坐标 ±1200 处，包围球在原点）⇒
    // 花瓣全丢。显式给无限半径包围球，使该不变量不依赖 `frustumCulled` 一处。
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), Number.POSITIVE_INFINITY);
    // renderOrder 唯一化（调用方按 objects 下标传入，同排透明队列按它排序 ⇒ 与 WE 绘制序一致）；
    // 缺省 1 = 粒子晚于背景（0）绘制，即「粒子不被背景盖住」的确定性保险。
    mesh.renderOrder = opts.renderOrder ?? 1;
    if (opts.isolate) {
        // 粒子隔离：世界位移改由「内容 mesh 的负中心平移」承载，**不要**改 objCenter/objAngles
        // uniform —— shader 用 `local = particlePosition - objCenter - bmOffset` 反解局部坐标，而
        // particlePosition 本身就含对象中心（sim 以对象中心为发射基准），置零会让反解错误、内容整体出画。
        //   mesh.position = -objCenter ⇒ 局部场景最终位置 = R(angles)·(scale·(emitterOrigin+local))
        const c = opts.objectCenter ?? [0, 0, 0];
        mesh.position.set(-c[0], -c[1], -c[2]);
    }
    else {
        host.scene.add(mesh);
    }
    // 图层 id（本方法返回值 = particleLayers 的键）由本类计数器分配；隔离条目的键是
    // **scene.json 的对象 id**（`opts.isolate.objectId`），两套编号互不相干（见 attachIsolated）。
    const id = host.nextLayerId();
    const layer = {
        id,
        getter: simVerticesGetter,
        frameCount,
        geometry,
        material,
        mesh,
        positions,
        sizes,
        uvs,
        colors,
        alphas,
        rots,
        velocities,
        capacity,
        loggedFirstFrame: false,
        loggedCount: 0,
        refract: refractEnabled,
        loggedRefract: false,
        parallaxDepth: opts.parallaxDepth,
        parallaxCenter: [(opts.objectCenter ?? [0, 0, 0])[0], (opts.objectCenter ?? [0, 0, 0])[1]],
        // 时间线 origin 动画的平移基准：opts.objectCenter 是 we_to_three 后的中心，加回 scene/2
        // 得到 scene 坐标的对象 world origin；scale/angles 只用于判断「是否只有 origin 变化」。
        baseWorldOrigin: [
            (opts.objectCenter ?? [0, 0, 0])[0] + host.sceneWidth / 2,
            (opts.objectCenter ?? [0, 0, 0])[1] + host.sceneHeight / 2,
            (opts.objectCenter ?? [0, 0, 0])[2],
        ],
        baseWorldScale: [...(opts.objectScale ?? [1, 1, 1])],
        baseWorldAngles: [...(opts.objectAngles ?? [0, 0, 0])],
    };
    host.addLayer(layer);
    // 立即写入首帧数据，保持 geometry 与 getter 一致（后续由 updateParticles 逐帧刷新）。
    writeParticleData(layer, initial, count);
    if (opts.isolate) {
        const center = opts.objectCenter ?? [0, 0, 0];
        // 世界尺寸由调用方按 particleWorldSize 算好传入，与 RT 像素尺寸**不可混用**：quad 世界占位若
        // 误用 RT 像素会被 dpr/预算收口二次缩放。quadAngles 传 [0,0,0]（RT 内容已含 R(angles)，再转
        // 一次就是双重旋转；背景路径相反）；colorBlendMode 传 0（粒子走普通 alpha 混合）。
        // 键 = scene.json 的对象 id，不是上面的图层计数器 id。
        host.attachIsolated(opts.isolate.objectId, 'particle', mesh, opts.isolate.worldW, opts.isolate.worldH, { width: opts.isolate.rtWidth, height: opts.isolate.rtHeight }, { x: center[0], y: center[1], z: center[2] }, [0, 0, 0], 0, opts.renderOrder);
        // 隔离层的视差落点是合成 quad（内容 mesh 在对象 RT 内坐标为 -objCenter，不能在那里平移）。
        layer.parallaxIsolated = true;
        layer.parallaxQuad = host.isolatedQuad(opts.isolate.objectId);
    }
    // scene 对象 id → 显示对象（隔离时是合成 quad，否则是粒子对象本身）。
    if (opts.objectId !== undefined) {
        const shown = opts.isolate ? host.isolatedQuad(opts.isolate.objectId) : mesh;
        if (shown)
            host.setDisplayObject(opts.objectId, shown);
        // 时间线世界变换只支持非隔离粒子（隔离粒子的合成 quad 归 isolated 边界）。
        if (!opts.isolate)
            host.setObjectToParticle(opts.objectId, layer);
    }
    // 折射层必须在自己被绘制**之前**拿到本帧快照 ⇒ 它本身就是段边界消费者（displayObjects 已登记，
    // 由 checkFrameConsumers 激活；setFrameCapture 晚于本调用时，激活发生在它那次评估里）。
    if (refractEnabled && opts.objectId !== undefined) {
        host.setRefractLayer(opts.objectId, layer);
        host.registerFrameConsumer(opts.objectId);
    }
    return id;
}
export function updateParticles(host, dt) {
    for (const layer of host.layers()) {
        const data = layer.getter();
        const count = Math.floor(data.length / PARTICLE_FLOATS_PER_INSTANCE);
        // 诊断日志（真机 console 用；确定性判据），每层最多两行：① 首次出现非零粒子时打一条，含 dt
        // 与容量（dt≈0 / 缺本行 ⇒ 帧循环没在推进模拟）；② 粒子数首次满池时再打一条（证明持续累积
        // 发射到 maxcount）。只打首帧 count=1 极易被误读成「模拟只发射了 1 个粒子」。
        if (count > 0 && !layer.loggedFirstFrame) {
            layer.loggedFirstFrame = true;
            layer.loggedCount = count;
            console.log(`[three] 粒子已产出 layer=${layer.id} count=${count} dt=${dt.toFixed(4)}s capacity=${layer.capacity}` +
                `（首帧非零；模拟每帧累积发射，满 capacity 时再打印一条）`);
        }
        else if (layer.loggedCount < layer.capacity && count >= layer.capacity) {
            layer.loggedCount = count;
            console.log(`[three] 粒子已达 maxcount layer=${layer.id} count=${count} dt=${dt.toFixed(4)}s`);
        }
        writeParticleData(layer, data, count);
    }
}
// 把 per-particle 摊平顶点（每粒子 16 浮点）拆到 7 个 instanced 属性并标记需重传。
// 容量不足时按需扩容（正常不会发生：容量 = sim 的 maxcount）——扩容后**必须**同步
// `geometry._maxInstanceCount`（three 的首帧锁存值，见 addParticle 注释），否则 draw 仍按旧容量截断。
export function writeParticleData(layer, data, count) {
    const ensure = (attr, itemSize, need, name) => {
        const arr = attr.array;
        if (arr.length >= need)
            return attr;
        const grown = new Float32Array(Math.max(need, Math.max(arr.length * 2, 1)));
        grown.set(arr);
        const next = new THREE.InstancedBufferAttribute(grown, itemSize);
        layer.geometry.setAttribute(name, next);
        return next;
    };
    layer.positions = ensure(layer.positions, 3, count * 3, 'particlePosition');
    layer.sizes = ensure(layer.sizes, 1, count, 'particleSize');
    layer.uvs = ensure(layer.uvs, 2, count * 2, 'particleUv');
    layer.colors = ensure(layer.colors, 3, count * 3, 'particleColor');
    layer.alphas = ensure(layer.alphas, 1, count, 'particleAlpha');
    layer.rots = ensure(layer.rots, 3, count * 3, 'particleRot');
    layer.velocities = ensure(layer.velocities, 3, count * 3, 'particleVelocity');
    // 实际容量 = 最小的「每实例元素数」换算回粒子数（7 个属性同步扩容，取最小以保守）。
    const minCapacity = Math.min(Math.floor(layer.positions.array.length / 3), layer.sizes.array.length, Math.floor(layer.uvs.array.length / 2), Math.floor(layer.colors.array.length / 3), layer.alphas.array.length, Math.floor(layer.rots.array.length / 3), Math.floor(layer.velocities.array.length / 3));
    if (minCapacity > layer.capacity) {
        // 超出预分配容量（spec 未声明 maxcount 或声明不准）→ 同步 three 锁存的实例容量。
        layer.capacity = minCapacity;
        layer.geometry._maxInstanceCount = minCapacity;
    }
    const pos = layer.positions.array;
    const size = layer.sizes.array;
    const uv = layer.uvs.array;
    const color = layer.colors.array;
    const alpha = layer.alphas.array;
    const rot = layer.rots.array;
    const vel = layer.velocities.array;
    for (let i = 0; i < count; i++) {
        const b = i * PARTICLE_FLOATS_PER_INSTANCE;
        pos[i * 3] = data[b];
        pos[i * 3 + 1] = data[b + 1];
        pos[i * 3 + 2] = data[b + 2];
        size[i] = data[b + 3];
        uv[i * 2] = data[b + 4];
        uv[i * 2 + 1] = data[b + 5];
        color[i * 3] = data[b + 6];
        color[i * 3 + 1] = data[b + 7];
        color[i * 3 + 2] = data[b + 8];
        alpha[i] = data[b + 9];
        rot[i * 3] = data[b + 10];
        rot[i * 3 + 1] = data[b + 11];
        rot[i * 3 + 2] = data[b + 12];
        vel[i * 3] = data[b + 13];
        vel[i * 3 + 1] = data[b + 14];
        vel[i * 3 + 2] = data[b + 15];
    }
    layer.positions.needsUpdate = true;
    layer.sizes.needsUpdate = true;
    layer.uvs.needsUpdate = true;
    layer.colors.needsUpdate = true;
    layer.alphas.needsUpdate = true;
    layer.rots.needsUpdate = true;
    layer.velocities.needsUpdate = true;
    layer.geometry.instanceCount = count;
}
