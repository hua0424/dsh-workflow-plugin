# 运行监控页：better-sidebar Tab + 宿主只读 RPC + Run 冻结快照

状态：设计已确认（尚未实施；实施与验收记录见后续 issue）。

向用户展示当前 Run 推进到哪个节点、各角色生效模型。载体是已安装的 DSH-better-sidebar 的扩展点 `ctx.betterSidebar.registerTab`（右侧栏 tab，`id: dsh-workflow:monitor`），不做独立浮窗、不占用原生主面板。本插件浏览器 bundle 用**动态注入**注册（不进静态 `inject` 导出）：未装 better-sidebar 时 tab 静默缺席，配置编辑器照常加载；这优于把三方宿主变成硬依赖。每个 tab 组件收到 `scope.cwd`（会话工作目录），经 canonical workspace 定位「一 workspace 一活跃 Run」。

数据通道是插件宿主半新增的**只读 status RPC**（与编辑器 RPC 同一 webServer 挂载方式、同源鉴权），浏览器不做任何文件访问：不要求用户再走 File System Access API 授权目录。运行图数据源是 Run 启动时冻结的 Definition Snapshot 与 node_executions 状态投影（`ready|working|checking|settling|exited` + BLOCK 原因 + 重做 visit），不是当前 catalog YAML——Run 启动后改配置不得改变运行图。节点坐标读 catalog 目录 `<id>.layout.json`（与配置编辑器共用同一布局文件，宿主侧读取），缺失坐标沿用画布组件的网格兜底；坐标是纯展示数据，读取 live 文件不违反冻结。

刷新采用 `visible` 时每 2 秒轮询（TabComponentProps.visible 官方语义：不可见即暂停），不引入 WebSocket 推送。v1 **严格只读**：不提供 resume/reset/切模型等任何控制入口——浏览器 RPC 是未授权的新信任路径，绕过「工具调用绑定 dispatch/nodeToken」的引擎授权模型；控制操作仍走 Manager 会话。token 用量/成本不展示（无数据源）。展示范围：当前节点高亮、已完成节点标记、BLOCK 状态与原因摘要、每节点角色 + 生效模型（冻结路由 + 运行时 override）、run 级信息条（workflowId/runId/开始时间/耗时，附启动 prompt 查看入口——原文取自 Run 首个工作单的 input 快照，不新增持久化字段）；顶部切换器默认选中 cwd 对应 Run、可切其他 workspace 的活跃 Run；child-workflow 节点可下钻子流程运行图（多层 breadcrumb）。Judge 判定徽标留待后续增量。

拒绝的替代：原生 `sidebar.panellist` 主面板（全局 canvas，无会话 cwd 上下文，且与 #219 编辑器入口迁移方向纠缠）；浏览器直读文件（重复授权、绕过宿主）；按当前 YAML 渲染（违反 Definition Snapshot 冻结合同）。
