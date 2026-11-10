# ThreeScenePlayer God class 拆分设计（阶段式重构）

> 日期：2026-11-10 ｜ 来源：`docs/audit-2026-11-10/client-runtime.md` P0-9 ｜ 状态：已批准方案 A（class + 注入宿主引用，3 阶段）

## 1. 目标与不变量

`ThreeScenePlayer`（`src/client/threejs-player.ts:708-2989`，约 2280 行 / 70 方法 / 40+ 字段）按职责拆为 facade + 5 个协作运行时，**公开 API 与行为完全不变**：

- 不变量 1：`threejs-player.ts` 的导出（类与全部纯函数/接口/工厂）签名不变；`three-renderer.ts` 是唯一外部依赖方，零改动。
- 不变量 2：`tests/threejs-player.test.ts`（5400+ 行，全走公开 API）**不修改**，每阶段全量绿。
- 不变量 3：测试专用入口（`*ForTest` 方法）保留在 facade 上（转发的可留转发，依赖内部字段的留 facade）。
- 不变量 4：渲染行为逐帧等价（e2e colorblend 零差异）。

## 2. 形态：facade + 协作 class（宿主注入）

每个子系统一个 class，构造时注入**最小宿主接口**（只声明该子系统实际用到的字段/方法），facade 在构造器中实例化并转发公开方法。子系统内部不直接 `import` player（避免循环依赖），只依赖宿主接口 + three 类型。

```
threejs-player.ts（facade：渲染管线 + 生命周期 + 状态字段）
  ├─ sprite-sheet-runtime.ts   SpriteSheetRuntime   （spritesheetLayers 字段迁入）
  ├─ parallax-runtime.ts       ParallaxRuntime      （parallaxCfg/Target/Follow 迁入）
  ├─ visualizer-runtime.ts     VisualizerRuntime    （visualizerBars/pixelBars 迁入）
  ├─ util-content-runtime.ts   UtilContentRuntime   （utilContents 迁入）
  ├─ layer-factory.ts          LayerFactory         （图层装配方法迁入，阶段 2）
  └─ frame-capture-runtime.ts  FrameCaptureRuntime  （抓帧/段渲染/快照，阶段 3）
```

## 3. 阶段划分（每阶段一个 commit，完成即全量测试绿）

| 阶段 | 迁移内容 | facade 预期 | 风险 |
|---|---|---|---|
| 1 | SpriteSheet（~150 行）+ Parallax（~120 行）+ Visualizer（~180 行） | 2280 → ~1900 | 低：字段少、与渲染循环仅 update 内单点调用 |
| 2 | UtilContent（~200 行）+ LayerFactory（~800 行） | → ~1100 | 中：图层装配被 addBackground/addPuppet/addParticle/updateBackground 共用 |
| 3 | FrameCapture（~350 行：captureNextFrame/renderSegmented/renderIsolatedContents/frameConsumers/refractLayers） | → ~700 | 高：与 render 主循环/隔离渲染强耦合，最后做 |

## 4. 每阶段验收

1. `npx vitest run tests/threejs-player.test.ts` 绿（推进前先跑一遍基线）。
2. `pnpm test` 全绿（5433 行测试不改一行）。
3. `node scripts/verify-arch.mjs` 绿（新模块仍在 client 层、禁 node:*）。
4. `pnpm run build && node scripts/build-client.mjs` 产物同步。
5. 公开导出面不变（`git diff` 只删类内实现、不改导出签名）。

## 5. 风险与回滚

- 每个子系统独立 commit，任一阶段出问题只回滚该 commit。
- 迁移方法时先「复制到 runtime + facade 转发」，测试绿后再删 facade 内旧实现（避免大 diff 里定位行为变化）。
- 若某子系统与 this 状态耦合超出预期（如 LayerFactory 依赖 20+ 字段），该阶段降级为「只搬方法体、宿主接口显式列出全部依赖字段」，不强行抽状态。
