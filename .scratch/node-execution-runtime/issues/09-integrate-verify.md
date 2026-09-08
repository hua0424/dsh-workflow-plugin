## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T9：把已接通的各纵向切片收敛为唯一新Runtime，完成所有验收、旧逻辑删除和文档同步，给出可独立核查的交付证据。

## Acceptance criteria

- [ ] #7 A01–A30逐项有通过/未运行/阻断的明确证据，不能用静态审查或stub通过代替真实宿主结论。
- [ ] 删除旧Run pending权威镜像、内存唯一工作材料、summary双文本、重复packet/派发/恢复路径；保留Role复用/compact、身份校验、安全收口和Judge只读。
- [ ] 全量build/typecheck、unit、隔离smoke通过，无切换期未接通执行类型或遗留双引擎；新增非平凡逻辑有行为回归检查。
- [ ] 在目标DSH 0.1.2-rc.1隔离home验证Role cold continuation、compact、claim/turn收口及一次中断续作；真实宿主和模型stub证据分开，条件不足不伪报通过。
- [ ] 同步领域术语、权威Graph设计、工具合同和升级说明；不覆盖用户已有示例配置改动，必要示例使用安全独立交付。
- [ ] 报告删除清单、升级/授权退出步骤、残余限制；无部署、真实Run故障注入、自动资源清理或未经请求push。
- [ ] Standards/Spec双轴最终审查，修复有效发现并提交；父Spec #7不因拆票或子票完成而自动关闭。

## Blocked by

- #15 — T7：完整执行类型与分支交接。
- #12 — T8：旧格式保护与 Reset。
