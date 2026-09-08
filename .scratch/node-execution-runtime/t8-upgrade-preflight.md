# T8 安全升级预检（非实现，不解除 #10 阻塞）

- 现有存储启用 WAL。旧格式授权备份不能只 copy 主 sqlite 文件而忽略已提交但尚未 checkpoint 的 WAL。
- 当前 Node v24.16.0 已实测 `node:sqlite` 导出 `backup` 函数；T8 优先用原生一致性备份或受控 VACUUM INTO，再做被授权的退出操作，不复制一个自制备份器。
- 备份失败时原行/格式/运行资格都不能被部分修改；备份路径位于隔离或私有数据目录，不覆盖用户已有文件。测试必须包含已提交 WAL 数据的保存。
- 区分新格式 Run 的 Reset（terminated、保留三表历史）与旧格式的授权备份/退出，不为了退出旧 Run 强制精确重建其执行现场或建设双引擎。
- Reset 撤权不是停止外部工作；已知冲突活动仍须停止/等待，未知由 Manager/用户核查。不要因末端只读 Judge 漏了 turn/end 而新增永久 completed-workspace 锁。
- 坏库/错误格式应可诊断且 fail-closed，不能自动删库重建空库后声称恢复成功。

## T3 后新增核实

- 当前 StateStore 构造函数遇旧表有数据会直接关闭DB并抛错；在真实插件 apply 阶段这会使命令/工具都未注册，用户无法通过插件执行诊断、备份或授权退出。T8必须让插件以受限maintenance状态成功加载：普通Run读写继续fail-closed，但直接人类仍可查看兼容性并调用明确的全库备份/退出入口。
- 旧单表可能包含多个workspace，不能把普通当前workspace reset悄悄解释成删除全部旧Run。最小安全合同建议使用明确参数/命令（例如 reset的显式 incompatible-store确认值）：先对整个SQLite做一致性备份，成功后才替换为新空三表；提示这是全存储cutover。若只删除单workspace仍留下其他旧行，则须支持新旧表同库maintenance，会显著增复杂度，不符合本次目标。
- `node:sqlite backup(sourceDb, destination)`已在当前Node类型/运行时核实；把备份操作放StateStore/维护入口同一串行队列，目标存在时拒绝覆盖或生成唯一私有时间戳路径。备份完成后再关闭/替换源库；失败不改变任何文件/资格。
- 新格式普通 Reset 与旧库cutover不同：新Run应写terminated并保留三表历史；旧库无法可靠构造新历史，只能在完整备份后明确切换，且报告备份路径。

本文件只记录测试与数据安全注意项。实施 T8 前重读完成后的 StateStore/command入口，并用含WAL提交、多workspace旧行、备份失败/目标冲突和重新打开的隔离测试验证。
