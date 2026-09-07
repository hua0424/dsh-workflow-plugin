# T1 / Issue #8：DSH 0.1.2-rc.1 兼容基线

- 工单：<https://github.com/hua0424/dsh-workflow-plugin/issues/8>。
- 分支：refact。
- 开始代码基线：`d816aacf9037f5741469e49a76d70480c8b254c3`；中途仅文档提交 `d4e9ac4`，本票实现审查固定此点。
- 环境：Windows，Node v24.16.0，pnpm 10.10.0。
- 状态：T1 验收与双轴审查通过，变更随本报告提交；未实现或未验证的后续票能力不计入本票完成范围。

## 范围

对齐实际发布的目标宿主包及必要源代码合同变化，保持当前 Workflow 行为。不在 T1 实现三表、单文本 claim、新恢复模型或改变 compact 的业务策略。

允许必要宿主开发依赖，不新增直接运行依赖；不部署、不改真实 Run、不修改用户的示例配置。

## 改动前基线

| 检查 | 结果 | 范围 |
|---|---|---|
| pnpm run build | exit 0 | TypeScript 构建/类型检查 |
| pnpm test | 218/218 通过，exit 0 | 现有全部 node:test |
| pnpm run test:e2e | E2E SMOKE PASS，exit 0 | 真实 Engine/SQLite/Catalog，模型派发 stub，临时 home/workspace |

这些结果只证明原依赖下的当前行为；不代表目标宿主适配完成。smoke 不等同真实宿主 E2E。

## 已确认的兼容变化

- 原有七个 DSH devDependencies 的 `0.1.2-rc.1` 精确发布版本均存在，使用正规包管理器刷新锁文件，不文本替换 lock。
- 原 `followup` 与新版 distinct-turn Host 协议入口不同，不能机械替换为 nearest-step 的 sendMessage。
- Session 的事件读取改为 snapshotEvents 等能力；尤其工具调用身份提取的 duck typing 路径需行为测试，不能只依赖编译。
- JSON helpers 已迁移到目标宿主提供的 util-values 包，必要时声明宿主 devDependency 并复用，不复制验证实现。

## Red → Green 与改动后检查

实施者已报告以下已执行回归，父审查后补充最终检查：

- 精确升级后 build 出现 8 处类型错误，暴露旧 followup、Session.events 和 JSON helper exports 的断点。
- 真实目标 Session 的 native claim 测试先因提取不到 dispatch ID 失败；改为 snapshotEvents 后通过，仍排除后续 Turn 的消息。
- 原 Judge 真实 Session 投影测试在新事件读取合同下出现 8 项失败；适配 snapshotEvents 后通过，并新增精确 Workflow plugin 来源/Node 边界隔离验证。
- Role 和 Judge 续接通过正式导出的 Host distinct-turn queue，测试核对真实 Manager 归因、message ID 返回与无 live Manager 的拒绝，不用 nearest-step sendMessage 替代。
- JSON helpers 复用目标宿主 util-values；该包新增为 devDependency，直接运行依赖仍只有 yaml/zod。
- 包管理器顺带改写的 cordis 与 Node 类型声明范围已撤回；正规重装解析传递 peer，实施者报告当前锁文件不再包含旧 0.1.1-rc.2。

实施者完成的最终检查：

| 检查 | 结果 |
|---|---|
| tools + turnbind（native/Code Mode 真 Session，含伪造 root/subcall） | 36/36 通过 |
| catalog + state（JSON helper exports） | 34/34 通过 |
| Judge 投影（含精确 plugin 来源） | 16/16 通过 |
| Host compact/continuation（含三种 Host Queue 派发） | 12/12 通过 |
| pnpm run build | exit 0 |
| pnpm test | 222/222 通过，exit 0 |
| pnpm run test:e2e | E2E SMOKE PASS，exit 0 |
| pnpm install --frozen-lockfile --ignore-scripts | exit 0 |
| 本票文件 git diff --check | exit 0 |

父任务独立复验同一冻结源码：build exit 0，222/222 tests exit 0，隔离 smoke 输出 E2E SMOKE PASS、exit 0。原有示例文件的空白告警不属于本票，不作修改。

最终锁文件的 20 个 DSH 包均为 0.1.2-rc.1，无旧 0.1.1-rc.2/peer 警告；保留 pnpm 自身 DEP0169 url.parse 和 Git LF/CRLF 提示，不伪报运行失败。父任务 `pnpm list --depth 0` 确认 8 个直接 DSH devDependencies 为目标精确版本，运行依赖仍为 yaml/zod。

实施者只读核实实际 DSH 安装目录可以解析/加载 util-values 和 subagent/internal 的所需 exports；这证明新增宿主开发依赖的运行提供方存在，不等于完整真实宿主 E2E 通过。

## Standards

独立审查：0 项。固定 d4e9ac4 的本票 10 文件工作区 diff，对照项目/用户全局标准及 12 类 smell baseline。无明确文档标准违反或值得报告的 smell；短 Host 调用重复遵守最小适配原则，不为此新增转发抽象。开发依赖归属与行为回归检查符合约定。

## Spec

独立审查：0 项明确发现。未发现 T1 要求缺失、scope creep 或确定语义缺陷。精确发布 Host Queue 保持 distinct-turn 和父子授权；snapshotEvents 的完整事件读取适用于 native/Code Mode 绑定；投影仍按精确本插件来源与派发 message ID 隔离，不泄漏 Manager/旧 Node/其他 plugin 材料。前后基线与实际宿主验证范围已明确。

两轴分别报告，均无未解决发现。审查为只读；独立执行的构建/测试结果另列于上文。

## 交付与限制

T1 实现与本报告作为同一票提交，提交消息关联 #8；具体 commit 见 Git 历史和工单结案评论。真实 DSH 隔离宿主完整链路由 T9 单列验证，不在本报告中假报通过。未 push、部署或改写真实 Run；用户示例配置保持原有未提交状态。
