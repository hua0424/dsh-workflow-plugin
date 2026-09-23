## Problem Statement

当前插件以 agent-workflow/v3 YAML 定义角色、模型、persona、主流程、子流程及节点结果路由。手写配置需要同时维护嵌套字段、引用与多出口关系，容易漏项或产生不合法配置。用户需要嵌入 DSH Web 的图形配置工具，既能新建配置，也能加载并修改现有文件，完整支持当前 YAML 合同，而非只画流程图。

## Solution

提供宿主内的独立全局配置面板，采用 React Flow 处理画布交互、普通表单编辑配置属性，复用现有 YAML 解析与校验能力。只负责配置，不提供运行控制。

用户打开并授权本机目录，从列表选择 YAML；自动加载固定同名的布局文件，例如 review.yaml 对应 review.layout.json，不允许单独选择布局文件。没有布局则简单网格摆放。编辑后显式保存：配置通过校验后直接覆盖，只有布局变化时只写布局文件。不检查外部修改，不自动保存草稿。

## User Stories

1. As a 工作流配置者, I want 从 DSH Web 侧栏打开独立配置面板, so that 不必启动另一套服务。
2. As a 工作流配置者, I want 授权浏览器访问一个本地目录, so that 文件访问边界清晰可控。
3. As a 工作流配置者, I want 从目录列表选择 YAML, so that 能编辑已有工作流。
4. As a 工作流配置者, I want 新建 v3 配置并指定合法文件名, so that 不必手写完整 YAML 结构。
5. As a 工作流配置者, I want 自动加载同目录同名的布局文件, so that 不用手动关联文件。
6. As a 工作流配置者, I want 无布局时按简单规则摆放节点, so that 可以立即开始整理画布。
7. As a 工作流配置者, I want 布局损坏时得到提示并回退简单摆放, so that 合法配置仍能编辑。
8. As a 工作流配置者, I want 编辑公共 actorCommonPersona, so that 能配置共同角色背景。
9. As a 工作流配置者, I want 管理 roles 及其 persona, so that 能配置不同 Role Actor 的职责。
10. As a 工作流配置者, I want 编辑角色与 Judge 的 provider、modelId、可选 reasoningEffort, so that 能完整配置模型路由。
11. As a 工作流配置者, I want 区分未设置模型与显式设置模型, so that 保留现有继承和默认语义。
12. As a 工作流配置者, I want 编辑角色 reuse 和 tools.deny, so that 配置不局限于流程关系。
13. As a 工作流配置者, I want 单独编辑 judgeRole 的 persona、模型和工具限制, so that 保留独立 Judge 合同。
14. As a 工作流配置者, I want 切换主流程与本文件子流程, so that 能分别管理其节点、入口和返回结果。
15. As a 工作流配置者, I want 添加和修改 Actor 节点的角色、指令及 Checker, so that 能完整配置执行和验收要求。
16. As a 工作流配置者, I want 编辑共同 criteria 和每个命名结果的 criteria, so that 不丢失出口验收条件。
17. As a 工作流配置者, I want 从结果端口拖线选择目标, so that 直观看到不同结果的流转。
18. As a 工作流配置者, I want 不同结果可以指向同一目标, so that 不受错误的边去重规则限制。
19. As a 工作流配置者, I want 支持多节点返工回路, so that 能表达开发、审查与返工。
20. As a 工作流配置者, I want 编辑器阻止节点直接指向自身, so that 符合本界面的自环限制。
21. As a 工作流配置者, I want 选择内置 Program 并编辑参数及 PASS/FAIL 结果, so that 无需写任意程序脚本。
22. As a 工作流配置者, I want 引用本文件子流程并编辑 onReturn 映射, so that 子流程各返回结果都有明确后续。
23. As a 工作流配置者, I want 拖动节点并保存布局, so that 下次打开仍能恢复位置。
24. As a 工作流配置者, I want 重命名时保持相关引用一致, so that 不必逐一手工修正关联。
25. As a 工作流配置者, I want 撤销和重做表单、节点、连线及位置修改, so that 误操作可以恢复。
26. As a 工作流配置者, I want 查看只读 YAML 预览, so that 知道图形操作对应的配置内容。
27. As a 工作流配置者, I want 编辑过程中允许暂时不完整并显示诊断, so that 可以逐步完成配置。
28. As a 工作流配置者, I want 保存前通过现有配置校验, so that 输出可被插件加载。
29. As a 工作流配置者, I want 点击保存后直接覆盖目标文件, so that 不需要冲突检查或合并流程。
30. As a 工作流配置者, I want 只调整布局时不重写 YAML, so that 不产生无关格式变化。
31. As a 工作流配置者, I want 分别知道 YAML 和布局的保存结果, so that 部分失败不会被误报为成功。
32. As a 工作流配置者, I want 离开时获知未保存修改, so that 可以取消离开或明确放弃。
33. As a 工作流配置者, I want 得知目录权限不足或浏览器不支持, so that 不会误以为文件已经加载或保存。
34. As a 工作流配置者, I want 输出保留全部支持字段及业务含义, so that 不因图形编辑丢失配置。

## Implementation Decisions

### 范围与架构

- React Flow 为图交互底座，不自研 SVG/Canvas，不引入 Dagre/ELK，不实现拓扑自动布局。简单网格初始摆放不分析拓扑。
- 表单负责公共配置、角色、Judge 和节点细节；画布只表达执行节点与结果路由。角色、模型、persona 不画成执行节点。
- 以一份配置草稿为业务数据来源，图为投影，布局另存；不维护两套独立业务模型再拼接导出。
- 不更改现有 v3 schema、运行时或 Definition Snapshot。只在编辑器禁止直接自环，现有插件仍允许其原有合同；多节点回路继续支持，不能假定为 DAG。
- 导入含直接自环或不合法配置时明确拒绝进入图形编辑，用户外部修正后重新加载。不静默删除连线、未知字段或改变结果去向。

### 宿主接入与构建

- 使用正式 root main keyed slot 注册全局面板，sidebar.panellist 提供入口，layout.selectPanel 切换；不使用 DOM 注入或私有选择器。不是独立 URL 路由承诺。
- 增加客户端声明、客户端导出和宿主模块加载器 factory 格式 bundle；React/React DOM 使用宿主共享实例，React Flow 及非宿主依赖随客户端提供，正确装载 CSS。
- 使用已有 connection RPC，同源、宿主鉴权，承载文本/JSON 的解析、诊断、校验和规范化输出。不接受任意服务端文件路径，不访问 catalog、Run 或状态库。Web 接入不得破坏非 Web 插件加载。
- 复用现有 parser、schema、validator、诊断结构和 Program 元数据；不要在浏览器复制配置合同。校验副本，避免规范化函数原地修改用户草稿。
- 现有源码与安装工件已核实面板/RPC 接缝；React peer 范围静态相容，不代表构建、CSS 或浏览器兼容已经验收。先做最小集成验证。

### 全字段编辑合同

- 固定 agent-workflow/v3；支持可选 actorCommonPersona。
- roles：角色 ID、persona、可选 model、reuse、tools.deny；judgeRole：persona、可选 model、tools.deny，无 reuse。
- model：provider、modelId、可选 reasoningEffort；不硬编码档位枚举。可选字段区分省略与显式值，不能用空字符串代替缺省。
- workflow 与 childWorkflows：分别编辑 startNode、returns 和 nodes；主流程入口复用现有 Manager Actor 限制。
- Actor：execution 的 type/role/instruction，checker 的 checkerId/config，共同 criteria 和各 results 的 criteria/target。
- Program：固定内置 programId、可选 instruction/config、固定 PASS/FAIL 各自的 criteria/target，不添加 Checker。配置参数提示来自元数据，不擅自要求所有运行时可补充的参数在保存时填齐；已有 config 内容不得因表单展示范围有限而丢失。
- Child：execution.workflowId 与 onReturn；映射键遵循被调用子流程 returns。保留现有禁止递归调用等校验。
- Target 恰好为同流程 node 或声明的 return。每个结果一个输出端口；多个结果可指向同一目标，边标识包含结果身份而非仅起点/终点。
- 流程返回可作为特殊视觉目标，但不得生成虚构执行节点；startNode 用入口标记表达。
- ID 重命名同步相关引用；删除不静默选择其他目标，未修正的引用由校验阻止保存。
- 工作流 ID 来自文件名，不向业务 YAML 新增 name、description、layout 等字段。
- 配置静态有效不等于模型在当前运行环境可用；不以保存成功承诺启动成功。

### 文件与布局

- 使用浏览器 File System Access API“打开目录”，只操作明确授权的目录；面向支持该能力的 Chrome/Edge。访问的是浏览器所在机器的文件，不是远端服务器文件。
- 不支持 API 或授权失败时明确提示，不悄悄退回手选布局或服务端路径读写。
- YAML 与同名 .layout.json 自动关联，布局按主流程/子流程及节点身份记录坐标，不复制角色、指令或连线业务数据。
- 缺失坐标简单补位，多余记录忽略，损坏布局警告后回退；读取异常如权限撤销应如实报错，不能冒充文件不存在。
- 保存显式触发。不检查外部修改、不做冲突合并、不再弹出覆盖确认；用户接受覆盖其他编辑器并行修改的风险。保存前仍必须校验业务配置。
- 仅布局变化只写布局；配置变化保存 YAML 与布局。两文件不承诺整体原子性，分别报告结果并保留未成功保存的修改状态。
- 输出采用统一 YAML 格式，不保证注释、原字段顺序或排版，打开及保存说明明确提示。
- 不自动保存或恢复未完成草稿；目录权限提示由浏览器负责，不能把保存动作视为绕过权限的授权。

### 编辑体验

- 顶部文件操作与保存状态、配置导航、主/子流程切换、节点工具入口、画布与属性面板、完整错误区域。
- 只读 YAML 预览，未通过校验时标为草稿，不提供源码双向编辑。
- 有上限的页面内撤销/重做，覆盖表单修改和节点/连线增删移动，不跨刷新恢复。
- 切换文件、关闭编辑器或刷新前提醒未保存的配置及布局，可取消或放弃；浏览器关闭提示尽力提供，不承诺崩溃恢复。

## Testing Decisions

用户已明确确认以下测试边界：主要按“打开目录 → 加载 YAML/布局 → 表单与画布编辑 → 校验 → 保存 → 重新加载”验收，复用真实 parser/schema/validator 与 node:test；浏览器补验权限、交互和失败行为，不启动真实 Run、不使用真实 catalog。

- 好的测试断言可观察行为与文件/诊断结果，不断言 React 内部状态、组件实现细节或源码文本形状。
- 优先复用当前 Catalog 的解析/校验测试入口，以及现有 v3 组合配置作为依据。主要新增高层编辑文件闭环测试；权限/写入失败仅在浏览器目录句柄边界注入受控结果，不为每个底层函数建立新 seam。
- 配置往返：覆盖公共 persona、角色/Judge、显式与缺省模型、effort、reuse、tools、三种节点、结果 criteria、主/子流程和返回映射；重新解析后业务含义一致，不要求 YAML 文本一致。
- 无效输入：旧版本、未知字段、受限 YAML 禁用语法、悬空引用、非法入口、Child 返回映射不完整、自环的编辑器限制；禁止静默修复。现有 Runtime 自环能力不得因 GUI 测试而被删除。
- 图形：多结果汇入同一节点、多节点回路、结果重命名/节点重命名引用一致性、删除后的诊断、Undo/Redo。
- 布局：自动同名匹配、缺文件、损坏文件、缺坐标、陈旧记录、不同子流程同名节点隔离，以及只改布局不写 YAML。
- 保存：无效业务配置不可写入；直接覆盖不做外部变化检查；YAML 成功布局失败等部分失败明确报告，可重试且不误清除未保存状态。
- 浏览器：实际宿主面板、React 单例/CSS、目录授权/拒绝/撤销、不支持 API、拖动连线、预览及离开提醒。模拟目录句柄不能替代至少一次真实浏览器文件权限验证，使用专用测试目录。
- 保持现有 verify 验收入口通过；浏览器验证单独报告。不把静态 peer 相容、mock 测试或仅构建通过称为真实宿主验收。

## Out of Scope

- 启动工作流、运行监控、BLOCK 处理、模型运行期切换或修改已运行的 Definition Snapshot。
- 拓扑自动布局、任意绘图、XOR/AND 网关、并行执行、自由条件表达式、新运行引擎。
- 直接自环图形编辑；不修改现有 Runtime 的自环合同。
- YAML 源码编辑、注释/排版保真、旧版 YAML 自动迁移。
- 自动保存草稿、跨刷新撤销、崩溃恢复、多人协作、外部修改检测、冲突合并。
- 服务端任意路径文件管理、自动扫描真实 catalog、远程服务器目录编辑、独立 Web 服务。
- 修改宿主以实现面板入口、DOM 注入、未经授权部署或重启。

## Further Notes

- 参考项目 https://github.com/yangdongzhen590/dsh-knj-workflow 只作为交互调研：实际是 React+自研 SVG，导入导出 JSON，不提供本项目所需的 YAML 往返；不直接移植其图语义、布局内嵌或 DOM 接入。
- 当前领域文档仍有 v2 遗留叙述；本需求以当前 v3 源码合同为准，使用 Node Result、Exit Contract、Workflow Return、Definition Snapshot 等现行术语，不据旧文档引入 PASS/FAIL 通用 Actor 路由。
- 建议顺序：宿主/目录 API 最小接入 → 文件解析校验保存闭环 → 完整表单与图映射 → 撤销及离开保护 → 浏览器和回归验证。保持实现简洁，不新增通用表单框架或工作流抽象层。
- 本 Issue 是已讨论配置编辑器的完整规格，不等同于部署授权。标记 ready-for-agent；本次发布不实施代码、不提交用户已有改动。
