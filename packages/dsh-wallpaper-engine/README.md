# @dsh-use/wallpaper-engine

DSH 壁纸引擎背景插件（Cordis 插件体系）：为 DSH Web GUI 提供 Wallpaper Engine 壁纸背景——视频壁纸直接播放、scene 壁纸由 Three.js 在浏览器中实时渲染（粒子/图片对象）、其余回退 preview 图 + Ken Burns。

- **phase0-2 里程碑**：EVA 壁纸（workshop 1280029027）在浏览器中由 Three.js 实时渲染出动态粒子背景（灰烬 / 光柱 / 雾）。
- 仅依赖浏览器原生能力与 `three`（无 Wallpaper Engine 运行时）：host 侧解包壁纸资源（`PKGV0001` 容器、`TEXV0005` 纹理），client 侧用 WebGL 渲染。

## 安装与集成

1. 依赖本包（`file:` 指向本地仓库，或经 `dsh plugin` 安装）：

   ```jsonc
   // C:\Users\<user>\.dsh\profiles\web\package.json
   {
     "dependencies": {
       "@dsh-use/wallpaper-engine": "file:E:/code/dsh-use-wallpaper/packages/dsh-wallpaper-engine"
     },
     "dsh": { "profile": { "bundles": ["@dsh-use/wallpaper-engine"] } }
   }
   ```

2. 将本包 `cordis.patch.yml`（注册插件 + `wallpaperDir` 配置）并入 profile 的 `C:\Users\<user>\.dsh\profiles\web\cordis.patch.yml`：

   ```yaml
   - insert:
       - id: dsh-wallpaper-engine
         name: '@dsh-use/wallpaper-engine'
         config:
           wallpaperDir: 'D:/Steam/steamapps/workshop/content/431960'
   ```

3. 重启/刷新 DSH Web GUI（`http://127.0.0.1:3080`）：
   - 设置面板出现壁纸引擎设置项；打开壁纸选择面板，显示壁纸缩略图网格；
   - 选择 scene 壁纸 → Three.js 实时渲染；选择视频壁纸 → mp4 循环播放；其余 → preview 回退。

## 构建与测试

```bash
cd packages/dsh-wallpaper-engine
npm install
npm run build          # tsc -p tsconfig.json（strict，产出 lib/）
npm run build:client   # esbuild 打包 client 入口 → dist/client.js
npx vitest run         # 全量单测（node + jsdom 双环境）
```

要求：Node ≥ 18（`fetch`）、TypeScript strict、ESM-only。

## 验证（阶段 2 里程碑）

1. 集成 profile 后启动 DSH Web GUI，确认设置面板与 26 个壁纸缩略图；
2. 选择 EVA（1280029027）：背景为 Three.js 渲染的动态粒子场景（灰烬/光柱/雾在动），主图铺满视口；
3. 选择视频壁纸：mp4 循环播放；选择其他 scene 壁纸：回退 preview 图 + Ken Burns；
4. 修改透明度/模糊并刷新页面，设置保持；
5. DevTools Performance：EVA 场景 FPS ≥ 30（1080p）。

## 架构

```
src/host/    Node 侧（Cordis 插件）：
  scanner.ts     扫描壁纸目录（project.json → WallpaperInfo）
  pkg-reader.ts  PKGV0001 容器解包（条目表 → readEntry(name)）
  routes.ts      HTTP 路由：/wallpapers/list、/wallpapers/media/<id>/{preview,file}、
                 /wallpapers/scene/<id>/asset?name=<资源名>（穿越防护 + 动态内容 no-store）
src/client/  浏览器侧（bundled to dist/client.js）：
  index.ts          入口：bootstrap + window.__wallpaperEngine（show/mountPicker）
  wallpaper-controller.ts  选择渲染 + scene 回退链（renderScene 失败 → preview）
  scene-assets.ts   scene 资源拉取：fetchSceneDescription / particlesFromSpec / fetchParticleSpec
  scene-json.ts     scene.json 解析（camera/orthogonal/objects/image/particle/size）
  scene-renderer.ts Three.js 渲染器：图片对象 + 粒子系统（点精灵/加法混合）+ renderScene 入口
  particles.ts      粒子模拟器 v1（emitter 速率/方向/距离 + initializer 生命周期/尺寸/速度，mulberry32 种子）
  tex-loader.ts     TEXV0005 纹理解析（LZ4 解压 → RGBA8888 DataTexture / DXT CompressedTexture）
  background-layer.ts / picker.ts / settings.ts / styles.ts
```

### 坐标数学（scene 渲染）

Wallpaper Engine 场景系为**左上原点、y 向下**；three 正交相机为**中心原点、y 向上**。映射：

```
three.x = we.x - vw/2；three.y = vh/2 - we.y（y 翻转）
```

- 图片对象：平面几何尺寸取 scene.json 对象 `size`（缺省回退纹理宽高），位置 = `(origin.x - w/2, -(origin.y - h/2), z)`。EVA 主图 `size=(2400,1555)`、`origin=(1200,777.5)=size/2` → three 位置 `(0,0)`，正好铺满正交视口。
- 粒子对象：发射原点按同式映射到中心系；`scale.y` 取负完成 y 翻转，粒子方向/速度与 WE 屏幕表现一致。

## 真实格式参考（research 沉淀）

wallpaper 资源逆向结论（见 `research/` 原型脚本与各 Task 报告）：

| 格式 | 要点 |
|---|---|
| `PKGV0001` | 16B 头（version + magic）+ 条目表 `nameLen(u32)+name+offset(u32)+size(u32)` + 数据段；offset 相对数据段起点。实现：`src/host/pkg-reader.ts`（原型 `research/parse-pkg.mjs`） |
| `TEXV0005` | `TEXV0005\0 TEXI0001\0` + 28B 头（Format/Flags/TextureW/H/ImageW/H）+ `TEXB0001/0002` 容器 + 每 image 每 mipmap：`width height [isLZ4 decompressedBytes] bytesLen` + 数据（LZ4 block）。TexFormat: RGBA8888=0/DXT5=4/DXT3=6/DXT1=7。实现：`src/client/tex-loader.ts` |
| scene.json | `camera/general.orthogonalprojection/objects[]`；对象按 `image`/`particle` 分派，`size`/`origin`/`scale` 为 WE 像素/坐标 |
| 粒子 json | `emitter[]`（rate/directions/distancemin/max）+ `initializer[]`（lifetimerandom/sizerandom/velocityrandom）+ `operator[]` + `material` + `maxcount`。v1 只取 emitter[0] + 三个 initializer；**emitter rate 缺省 10、distancemax 缺省 256**（对齐 linux-wallpaperengine 逆向源码） |

批量扫描所有壁纸 scene.pkg 内部文件类型的工具脚本：`research/scan-all-pkgs.mjs`。

## v1 已知限制

- 粒子渲染为白色点精灵（固定 uniform 尺寸 = initializer 平均尺寸），未实现每粒子尺寸/透明度衰减、粒子材质纹理、operator（gravity/alphafade）与子粒子（children）；
- `velocityrandom` 缺失的粒子系统（如 fog2）粒子静止；寿命极短的闪电类粒子（lightning1）视觉接近不可见；
- 图片对象仅加载第一张 tex（RGBA8888/DXT1/3/5），其他格式返回 null 跳过该对象；
- 全部对象渲染失败时 `renderScene` 返回 false，由 controller 回退 preview 图（回退链接线）。
