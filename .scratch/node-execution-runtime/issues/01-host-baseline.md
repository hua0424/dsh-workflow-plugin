## Parent

#7 — 工作单驱动的 Workflow Runtime 重构。实施分支：refact。

## What to build

T1：在目标 DSH 0.1.2-rc.1 下建立可重复的开发/测试基线，为后续重构排除旧宿主类型干扰。核实实际发布包版本，必要时对齐宿主 devDependencies 与锁文件；不实现新工作流行为。

## Acceptance criteria

- [ ] 记录改动前 build/typecheck、全量 unit、隔离 smoke 的结果，失败与环境限制如实记录。
- [ ] 所有直接 DSH 类型依赖与目标宿主的实际可用版本兼容；不假定每个包版本必然相同，不为旧类型新增运行时 shim。
- [ ] 宿主包仍是 devDependencies；不增加运行依赖，不部署插件，不操作真实 Run。
- [ ] 变更后运行同组检查；记录目标宿主验证的范围，stub smoke 不冒充真实宿主 E2E。
- [ ] 完成 Standards 与 Spec 双轴审查，修复有效发现并提交；保留用户未提交的示例配置改动。

## Blocked by

None (can start immediately).
