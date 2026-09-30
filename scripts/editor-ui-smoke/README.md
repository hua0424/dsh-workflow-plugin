# 编辑器真实浏览器冒烟

夹具使用当前客户端 bundle、真实 React 18 与服务端编辑器 RPC；配置和布局文件只在浏览器内存中，绝不读取或修改真实 DSH home。此项独立于 `pnpm run verify`，需要支持 File System Access 的 Chrome/Edge 和 `playwright-cli`。

准备 React 18 的 UMD 文件 `react.js`、`react-dom.js`（development 或 production 均可），放入独立目录。脚本不自动下载，也不增加项目依赖。缺少目录参数或文件会立即报错。

```powershell
node scripts/editor-ui-smoke/server.mjs <React文件目录>
# 在另一终端执行；默认使用独立无头浏览器。
playwright-cli -s=editor-smoke open http://127.0.0.1:43852 --browser=chrome
playwright-cli -s=editor-smoke resize 1280 720
playwright-cli -s=editor-smoke click "getByRole('button', {name: '打开目录', exact: true})"
playwright-cli -s=editor-smoke click "getByRole('button', {name: 'demo.yaml', exact: true})"
playwright-cli -s=editor-smoke run-code --filename=scripts/editor-ui-smoke/check-layout.cjs
playwright-cli -s=editor-smoke run-code --filename=scripts/editor-ui-smoke/check-interactions.cjs
playwright-cli -s=editor-smoke run-code --filename=scripts/editor-ui-smoke/check-models.cjs
playwright-cli -s=editor-smoke run-code --filename=scripts/editor-ui-smoke/check-pan.cjs
playwright-cli -s=editor-smoke run-code --filename=scripts/editor-ui-smoke/check-routing.cjs
playwright-cli -s=editor-smoke reload
playwright-cli -s=editor-smoke click "getByRole('button', {name: '打开目录', exact: true})"
playwright-cli -s=editor-smoke click "getByRole('button', {name: 'demo.yaml', exact: true})"
playwright-cli -s=editor-smoke resize 900 760
playwright-cli -s=editor-smoke run-code --filename=scripts/editor-ui-smoke/check-layout.cjs
playwright-cli -s=editor-smoke close
```

检查画布首屏可见、节点绝对定位、页面无横向溢出，以及真实鼠标拖动、一次撤销恢复、重做、保存布局坐标、重新打开文件、可见连线和节点选择。交互检查还覆盖修改节点指令并应用到 YAML、未保存时取消切换文件保留修改、点击结果端口连接返回目标并撤销。断言失败时 CLI 退出非零。重启服务会重新构建临时 bundle；浏览器刷新会重置夹具。结束后 Ctrl+C 停止服务并清理临时 bundle。

补充检查：结束节点拖动及保存重开、主流程入口 manager 锁定、长文本弹窗确认/取消、模型目录联动选择和字段按钮同行。模型目录由隔离夹具提供，宿主接入使用会话同源公开 API。

`check-pan.cjs` 刷新隔离夹具，用真实鼠标分别以右键和中键向四个方向连续拖动超过原图边界，以节点屏幕坐标验证无限平移；同时验证右键菜单抑制、松开停止、布局/文件/脏状态/历史不变和适应画布恢复全图。

`check-routing.cjs` 验证属性面板收起后画布加宽、展开保留未应用表单；折线选中高亮、缩放下横/纵路由手柄拖动的坐标折算、整次拖动撤销/重做，以及布局保存和重新打开后路线一致。

## 启动弹窗（#179）

`/start` 受控页挂载真实 bundle 的 `conversation.input.left` 注册（捕获组件 + 真实 `loadCatalog`/`runCommand` 闭包）：目录经只读 catalog RPC（三态 `ok`/`empty`/`error` 由 `POST /start-control` 切换），命令经页面 `__runCommand` 受控桩（`__execMode`：`success`/`command-error`/`transport-fail`/`throw`/`hang`，`__resolveHang` 落定挂起请求），绝不建 Run、不碰真实 DSH home。

```powershell
node scripts/editor-ui-smoke/server.mjs <React文件目录>
# 另起终端（独立无头浏览器）：
playwright-cli -s=start-smoke open http://127.0.0.1:43852/start --browser=chrome
playwright-cli -s=start-smoke run-code --filename=scripts/editor-ui-smoke/check-start-modal.cjs
playwright-cli -s=start-smoke close
```

覆盖：只读列表有效/警告可选与无效禁用、上下文提示、`.yaml` 展示与 workflow-id 提交、空 prompt 语义、命令失败保留输入、未知结果指引查状态不重试、刷新/取消零副作用、运行中/提交中/无 workspace 禁用、切换会话清理、提交闸门（挂起时 Escape/取消不可绕过、单次派发）。断言失败退出非零。

