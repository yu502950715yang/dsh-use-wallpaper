# Agent Note: 架构边界守卫（可执行的分层契约）

Status: implemented

## Problem

AGENT.md §2 的分层契约（host 是 Node 侧 / client 是浏览器侧 / shared 纯）此前**只写在文档里**，没有任何机制检查。审查时实测到一处真实越界：

- `src/host/user-props.ts` 直接 `import { parseUserRef } from '../client/user-bindings.js'`。
- 运行时能跑（编译后两者都在 `lib/`），但它把浏览器侧模块拖进了 host 的依赖图：client 模块一旦引入 three/DOM，host 编译产物就会连带失败或把浏览器依赖带进 Node 侧。

另外没有守卫时，以下边界只能靠人记：client/shared 不得用 `node:*`、host 不得引 three/react、src 不得反向依赖 `lib/`/`dist/`/`tests/`/`e2e/`。

## Decision

1. **先修违规**：新建 `src/shared/user-refs.ts`，把 `parseUserRef`（纯函数，只依赖 `UserBindingRef` 类型）放进去；host 从 shared 引用；`client/user-bindings.ts` 改为从 shared `import` + `export`（保持既有 import 面：client 各模块与 `tests/user-bindings.test.ts` 不用改）。
2. **新增守卫** `scripts/verify-arch.mjs`（零依赖纯 Node）：
   - 规则：`host-not-client` / `client-not-host` / `shared-pure` / `browser-no-node`（`node:*`）/ `host-no-browser-lib`（three/react/react-dom）/ `src-no-build-output`（lib/dist/tests/e2e/research）。
   - 相对说明符**解析成绝对路径再判目录**（不是字符串前缀匹配，`../../lib/...` 这类变体也能抓）；注释剥离但保留行号。
   - **规则自带合成红测**：每条规则至少一份「必须报红」的样本 + 正例不误报；自检不过同样 exit 1 —— 守卫自己写错了不会静默变绿。
3. **接线**：`npm run verify:arch`；CI typecheck job 在 tsc 前跑；`scripts/verify-local.mjs` 作为门禁 0；AGENT.md §3.3 记录。

## Affected repositories

- `dsh-use-wallpaper` 不涉及

## Alternatives considered

**给现有违规开白名单。** 不用它：违规只有一处且能正确下沉 shared，开白名单会让守卫从第一天起就有豁免，后续容易扩大。

**用 ESLint import 规则。** 不用它：仓库没有 ESLint（只有 tsc + vitest），新增 ESLint 依赖与配置的成本远高于一个 200 行零依赖脚本；且 ESLint 的 resolver 对 `.js` 后缀的相对导入配置更繁。

**只扫 `from '../client/'` 这类字符串。** 不用它：`../../client`、`src/client`、动态 `import()`、`require()` 都会漏；解析绝对路径才能覆盖全部形态。

## Consequences

**收益：** 分层/环境/产物反向依赖三类问题在 CI 与本地验收的第一道门禁就被拦下；引用 `parseUserRef` 的 host 依赖图恢复干净。

**验证：** 真实变异——把 `src/host/user-props.ts` 的 import 改回 client，守卫报红并精确指向 `src/host/user-props.ts:3`；提交后 `npm run verify:local` 全部门禁 PASS。

**代价：** 新增源码文件时若跨层引用会立即红，需要按规则下沉 shared；`verify:arch` 自身改动也要过自检样本（改规则忘加样本会自检失败）。
