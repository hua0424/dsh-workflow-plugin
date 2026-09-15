/**
 * 固定 Program 的**纯元数据单源**（#100 AC3）：programId + 参数合同
 * （分量类型 / 必填 / 说明）。
 *
 * 只依赖领域类型，不引入任何进程执行依赖——Catalog 静态校验
 * （catalog/validate.ts 的固定 id 名单）与 Runtime 参数校验
 * （engine.programParameters）读同一份定义，不存在需要手工同步的第二份名单；
 * 执行实现仍固定映射在 programs/catalog.ts 的 `BUILTIN_PROGRAMS`，配置不能注册
 * 任意程序。
 */

/** 参数分量的类型/必填/说明；只经 `ProgramMetadata` 暴露，不单独构成导出面。 */
interface ProgramParameterSpec {
  type: 'string' | 'number'
  required: boolean
  description: string
}

export interface ProgramMetadata {
  programId: string
  description: string
  parameters: Record<string, ProgramParameterSpec>
}

/** 固定 id → 元数据；执行实现由 programs/catalog.ts 按同一 id 挂载。 */
export const BUILTIN_PROGRAM_METADATA: Record<string, Omit<ProgramMetadata, 'programId'>> = {
  'github.initialize-milestone': {
    description: 'Create or verify the Milestone and the exact local+remote branch for the current workspace repository.',
    parameters: {
      title: { type: 'string', required: true, description: 'Milestone title' },
      branchName: { type: 'string', required: true, description: 'Branch name for the milestone work' },
    },
  },
  'github.all-milestone-issues-complete': {
    description: 'Check whether every issue in the milestone is closed.',
    parameters: {
      milestoneNumber: { type: 'number', required: true, description: 'Milestone number (from initialize-milestone or the GitHub UI)' },
    },
  },
}

/** Catalog 校验的固定 program id 名单：从元数据派生，不另维护。 */
export const BUILTIN_PROGRAM_IDS: ReadonlySet<string> = new Set(Object.keys(BUILTIN_PROGRAM_METADATA))
