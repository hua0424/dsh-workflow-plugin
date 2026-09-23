# Web 配置编辑器客户端（T1 最小闭环）

位置：`web-client/src/`（纯 JS + `React.createElement`，无 JSX、无第三方依赖）。
本目录在顶层 `tsconfig.json` 的 `src/**` 之外，服务端 `tsc` 不编译它；
`node --check` / `web-client/build.mjs` + 桩冒烟覆盖语法与模块形状。

## 组成

- `src/rpc.js` — 经 `ctx.connection.rpc.call('/workflow-config-editor', …)`
  调用 host 端 `parse/validate/preview/layout`。只发 `{workflowId, text/config}`
  受限文本/JSON，不发任何服务端路径。
- `src/panel.js` — T1 面板：打开授权目录 → 列合法命名 YAML → 自动关联
  `<stem>.layout.json` → 编辑公共 `actorCommonPersona`（设置/清除，应用后立即刷新
  只读预览）→ 主/子流程切换查看并拖动节点（仅位置）→ 只读预览 → 校验后显式
  保存 → 分别报告 YAML/布局写入结果。撤销/重做上限 50，页面内，不持久化，
  恢复快照脏标记（纯布局撤销后保存只写布局）；脏状态下打开目录/切换文件
  `confirm`，关闭/刷新 `beforeunload`（尽力提供）。
- `src/edits.js` — 面板纯状态变迁（无 React/DOM/RPC，node:test 直接覆盖）：
  面板侧唯一的编辑/历史/保存计划来源，脏语义钉住服务端 `savePlan`。
- `src/index.js` — 正式接入：`main` keyed 注册全局面板 +
  `sidebar.panellist` 入口（id 与 key 一致），无 DOM 注入，不另起服务器。
- `build.mjs` — 最小拼合：输出宿主模块加载器 factory 格式
  `window.__ModuleLoader__.load({ id, factory })`（banner/footer/intro 对齐
  宿主 `tsdown.client.ts` 约定）。产物 `dist/` gitignored，不提交：
  `node web-client/build.mjs [--out <目录>]`。

## 有意不做的（本票边界）

- 未声明 `package.json` 的 `dsh.client`、未加 `exports["./client"]`、
  `deploy-web.mjs` 未改：仓库内尚无可提交的已验证客户端产物；
  声明即进入宿主 boot 图，缺 bundle 会在激活期 fail-loud 拖累整个插件
  （含非 Web 加载）。管线 + 浏览器验证落地后再声明，二者是后票（图/表单票）的前置。
- 未引入 React Flow：画布为指针拖动最小占位实现（只改位置，不改拓扑）；
  React Flow + CSS + 正式 bundler 随 T3 图编辑票引入，本脚本届时退役。
- React/React DOM 取宿主共享实例（module-table baseline），本 bundle 只
  `require('react')`，不打包第二份（桩冒烟已断言除 react 外零 require）。

## 已验证（模拟）vs 待验证（真实浏览器）

已验证（本机真实执行，非浏览器）：
- `test/editor-t1-roundtrip.test.ts` 16 用例：真实 parser/schema/validator
  的加载→修改→保存→重载业务等价、全字段保留、布局恢复、无效输入、
  自环拒绝、部分写入失败、撤销/重做、RPC 受限输入与副本语义。
- `node web-client/build.mjs` 产物 `node --check` 通过；桩冒烟
  （`.scratch/web-client-smoke.mjs`，可复现）：factory 仅 require react，
  `apply` 注册 `main{key}` + `sidebar.panellist{id}`。
- `pnpm run verify` 通过（见 #160 实现评论）。

待真实浏览器验证（未做，不宣称）：
实际宿主面板挂载、`main`/`sidebar.panellist` 注册选项形状与生成 client
目录的一致性（`cordis_inspect what:"client"`）、React 单例与样式、
目录授权/拒绝/撤销、不支持 API 提示、拖动、离开提醒。静态相容与桩冒烟
不代替上述实测；部署仍需独立授权（父票 #159 边界）。

已确认无需验证的子项（宿主源码证据，不写代码）：
- `layout.selectPanel` 无需客户端注册：宿主切换前检查实时 `main` 注册表，
  缺 key 抛错并保留当前面板（`packages/client/ui-layout/README.md` +
  `service.ts selectPanel`）；客户端只需注册 `main` keyed 位。
- 面板取消选择（关闭面板）无客户端可拦截的钩子：`ui-slots` 无
  beforeClose/canClose/guard API，`selectPanel` 直接切换并卸载旧面板；
  在面板内拦截关闭需改宿主，而 #159 明确排除修改宿主。AC10 的关闭提醒
  子句需 spec 方缩窄或立宿主需求（r001 F4，已交 Manager 裁决）。
