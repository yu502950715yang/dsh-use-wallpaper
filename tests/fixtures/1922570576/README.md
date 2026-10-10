# tests/fixtures/1922570576 —— 「魔兽之门」文本脚本 fixture

`text-object-778.json` 是**真实素材的逐字复制**：

- 来源：`<workshop>/431960/1922570576/scene.pkg` 内 `scene.json` 的 `objects[id=778]`（`name: "3D Clock"`）字段子集。
- 用途：`tests/text-script.test.ts`「真实素材：魔兽之门 #778『3D Clock』脚本 bind 成功并输出 HH:MM:SS」。
- 背景（2026-10-10）：该脚本第 3 行是 `import * as WEMath from 'WEMath';`（WE 引擎注入的模块，不是文件），
  而被测运行时把整条语句原样丢进 QuickJS 的函数体 ⇒ `expecting '('` ⇒ bind 返回 null ⇒ 生产装配
  按「绝不画 text.value 占位值」的裁定**整层跳过** ⇒ 用户看不到右下角的时间数字。全库 33 个 text 脚本
  里只有这 1 条带 `import`。

fixture 里只保留了回归需要的字段（脚本原文 + 作者占位值 + 字号/对齐等元数据）；不含壁纸纹理与字体。
