/**
 * `dsh-workflow-init` 一键安装：对话内 `/dsh-flow init` 与仓库侧
 * `scripts/dsh-workflow-init.mjs` 共享的唯一落盘语义（Issue #209）。
 *
 * 安装内容：通用 Manager preset 声明（进 home patch `$DSH_HOME/cordis.patch.yml`）
 * + 默认工作流 YAML（进 catalog 目录 `$DSH_HOME/workflows/<id>.yaml`）。
 * 默认最小集（单仓快速模板），`--full` 装全部生产模板；v2 遗留模板与组合示例
 * 不在安装源内。已存在的用户文件永不静默覆盖：字节一致跳过，不一致默认跳过
 * 并提示首个差异行，只有 `--force` 才备份（`.bak-<timestamp>` 同目录兄弟）后覆盖；
 * `--dry-run` 只报告不写入。写完对每个目标文件做隔离校验（单个文件的问题只
 * 报告自身，不影响其他文件），工作流用本插件的受限解析 + 严格 schema + 静态
 * 校验，preset 声明做结构检查。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { parseDocument, YAMLMap, YAMLSeq, type ParsedNode } from 'yaml'
import { CATALOG_DIR_NAME, ID_PATTERN } from '../types.ts'
import { parseCatalogConfig } from '../catalog/parse.ts'
import { validateAndNormalize, computeDefinitionHash } from '../catalog/validate.ts'

export const PRESET_ROW_ID = 'preset-manager'
export const HOME_PATCH_FILENAME = 'cordis.patch.yml'
/** 最小集：最常用的单仓快速模板。 */
export const MINIMAL_WORKFLOW_IDS = ['coding-workflow-rapid'] as const
/** 全量：在最小集之外再加其余生产模板（v2 遗留 + 组合示例排除在外）。 */
export const FULL_WORKFLOW_IDS = [
  'coding-workflow-rapid',
  'coding-workflow',
  'coding-workflow-single',
  'coding-workflow-rapid-multi',
] as const

export const INIT_USAGE = [
  '用法：dsh-workflow-init [--full] [--force] [--dry-run] [--home <目录>]',
  '  缺省只安装最小集（coding-workflow-rapid）与通用 Manager preset；',
  '  --full 安装全部生产模板；--force 备份后覆盖已存在的不同内容；',
  '  --dry-run 只报告不写入；--home 覆盖目标 DSH home（对话内命令不支持）。',
].join('\n')

export interface InitOptions {
  full: boolean
  force: boolean
  dryRun: boolean
}

export interface InitSources {
  /** preset 声明源文件（单条声明行，由安装逻辑负责合并进 home patch）。 */
  presetFile: string
  /** 工作流源：id → 源文件。 */
  workflows: Array<{ id: string; source: string }>
}

export function parseInitArgs(argv: readonly string[]): { options: InitOptions; home?: string; help?: boolean; error?: string } {
  const options: InitOptions = { full: false, force: false, dryRun: false }
  let home: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    if (token === '--full') options.full = true
    else if (token === '--force') options.force = true
    else if (token === '--dry-run') options.dryRun = true
    else if (token === '--help' || token === '-h') return { options, home, help: true }
    else if (token === '--home') {
      const value = argv[index + 1]
      if (value === undefined || value === '' || value.startsWith('-')) {
        return { options, home, error: `--home 缺少目录参数\n${INIT_USAGE}` }
      }
      home = value
      index++
    } else {
      return { options, home, error: `未知参数 "${token}"\n${INIT_USAGE}` }
    }
  }
  return { options, home }
}

/**
 * 按布局解析安装源：bundle 布局（<root>/resources/workflows/*.yaml）优先，
 * 否则仓库布局（<root>/docs/example/*.yaml + <root>/resources/preset-manager.patch.yml）。
 * 任一必需源缺失即抛错（调用方在任何写入之前先解析，fail-closed）。
 */
export function resolveInitSources(root: string): InitSources {
  const bundleWorkflows = join(root, 'resources', 'workflows')
  const workflowsDir = FULL_WORKFLOW_IDS.every(id => existsSync(join(bundleWorkflows, `${id}.yaml`)))
    ? bundleWorkflows
    : join(root, 'docs', 'example')
  const presetFile = join(root, 'resources', 'preset-manager.patch.yml')
  const missing: string[] = []
  if (!existsSync(presetFile)) missing.push(presetFile)
  const workflows: InitSources['workflows'] = []
  for (const id of FULL_WORKFLOW_IDS) {
    const source = join(workflowsDir, `${id}.yaml`)
    if (!existsSync(source)) missing.push(source)
    else workflows.push({ id, source })
  }
  if (missing.length > 0) {
    throw new Error(`初始化资源缺失（未写入任何文件）：\n${missing.map(path => `- ${path}`).join('\n')}`)
  }
  return { presetFile, workflows }
}

/** 稳定 canonical 比较：排序 key 后 JSON 化（key 顺序不同不算差异）。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function firstDiffLine(sourceText: string, targetText: string): string {
  const sourceLines = sourceText.split('\n')
  const targetLines = targetText.split('\n')
  const common = Math.min(sourceLines.length, targetLines.length)
  for (let index = 0; index < common; index++) {
    if (sourceLines[index] !== targetLines[index]) {
      const show = (line: string): string => line.length > 80 ? `${line.slice(0, 80)}…` : line
      return `第 ${index + 1} 行不同：源 "${show(sourceLines[index]!)}" / 现有 "${show(targetLines[index]!)}"`
    }
  }
  if (sourceLines.length !== targetLines.length) {
    return sourceLines.length > targetLines.length
      ? `现有文件在第 ${common + 1} 行后缺失 ${sourceLines.length - targetLines.length} 行`
      : `现有文件在第 ${common + 1} 行后多出 ${targetLines.length - sourceLines.length} 行`
  }
  return '内容不同（空白或不可见字符差异）'
}

/** 同目录备份：`<path>.bak-<timestamp>`，冲突追加 -1/-2（与宿主 sanitizeProfile 同约定）。 */
function backupPath(path: string): string {
  const stamp = Date.now()
  const candidate = `${path}.bak-${stamp}`
  if (!existsSync(candidate)) return candidate
  let ordinal = 1
  while (existsSync(`${candidate}-${ordinal}`)) ordinal++
  return `${candidate}-${ordinal}`
}

type FileOutcome =
  | { status: 'installed' }
  | { status: 'up-to-date' }
  | { status: 'skipped-differs'; hint: string }
  | { status: 'overwritten'; backup: string }
  | { status: 'dry-run-write' }
  | { status: 'dry-run-skip'; hint: string }
  | { status: 'error'; reason: string }

/** 通用单文件落盘：比对源字节→（备份）写入。dryRun 下不做任何写入。 */
function applyFileBytes(target: string, sourceBytes: Buffer, force: boolean, dryRun: boolean): FileOutcome {
  const existed = existsSync(target)
  if (existed && readFileSync(target).equals(sourceBytes)) return { status: 'up-to-date' }
  if (existed && !force) {
    let hint: string
    try {
      hint = firstDiffLine(sourceBytes.toString('utf8'), readFileSync(target, 'utf8'))
    } catch {
      hint = '现有文件无法按文本比对（可能非 UTF-8）'
    }
    return dryRun ? { status: 'dry-run-skip', hint } : { status: 'skipped-differs', hint }
  }
  if (dryRun) return { status: 'dry-run-write' }
  mkdirSync(join(target, '..'), { recursive: true })
  let backup = ''
  if (existed) {
    backup = backupPath(target)
    writeFileSync(backup, readFileSync(target))
  }
  writeFileSync(target, sourceBytes)
  return backup === '' ? { status: 'installed' } : { status: 'overwritten', backup }
}

function renderFileOutcome(label: string, outcome: FileOutcome, dryRun: boolean): string {
  const tag = dryRun ? '（预演）' : ''
  switch (outcome.status) {
    case 'installed': return `installed${tag} ${label}`
    case 'up-to-date': return `up-to-date${tag} ${label}（与内置资源一致，跳过）`
    case 'skipped-differs': return `skipped ${label}：已存在且内容不同（${outcome.hint}）；--force 才备份后覆盖`
    case 'overwritten': return `overwritten${tag} ${label}（原文件已备份到 ${outcome.backup}）`
    case 'dry-run-write': return `would-install ${label}`
    case 'dry-run-skip': return `would-skip ${label}：已存在且内容不同（${outcome.hint}）`
    case 'error': return `error ${label}：${outcome.reason}`
  }
}

/** 已解析 patch 列表中 id 为 preset-manager 的声明位置（顶层行或 insert 块内）。 */
interface PresetRowRef {
  kind: 'top' | 'insert'
  index: number
  container?: number
}

function findPresetRows(rows: unknown): PresetRowRef[] {
  if (!Array.isArray(rows)) return []
  const found: PresetRowRef[] = []
  rows.forEach((row, index) => {
    if (typeof row !== 'object' || row === null) return
    const record = row as Record<string, unknown>
    if (record['id'] === PRESET_ROW_ID) {
      found.push({ kind: 'top', index })
      return
    }
    if (Array.isArray(record['insert'])) {
      record['insert'].forEach((nested, nestedIndex) => {
        if (typeof nested === 'object' && nested !== null
          && (nested as Record<string, unknown>)['id'] === PRESET_ROW_ID) {
          found.push({ kind: 'insert', index: nestedIndex, container: index })
        }
      })
    }
  })
  return found
}

/** preset 声明 / home patch 的结构检查：顶层列表，每行是有 name 或 insert 的 map。失败返回原因。 */
export function presetStructureProblem(value: unknown): string | undefined {
  if (!Array.isArray(value)) return '顶层不是列表'
  for (const [index, row] of value.entries()) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) return `第 ${index + 1} 行不是 map`
    const record = row as Record<string, unknown>
    if (typeof record['name'] !== 'string' && !Array.isArray(record['insert'])) {
      return `第 ${index + 1} 行既没有 name 也没有 insert`
    }
  }
  return undefined
}

function presetRowOf(rows: unknown[], ref: PresetRowRef): unknown {
  if (ref.kind === 'top') return rows[ref.index]
  const container = rows[ref.container!] as { insert: unknown[] }
  return container.insert[ref.index]
}

function applyPreset(home: string, presetSourceText: string, force: boolean, dryRun: boolean): { outcome: FileOutcome; mergedText: string | undefined } {
  const target = join(home, HOME_PATCH_FILENAME)
  let ours: unknown
  try {
    ours = parseDocument(presetSourceText).toJS()
  } catch (error) {
    return { outcome: { status: 'error', reason: `内置 preset 资源解析失败：${String(error)}` }, mergedText: undefined }
  }
  const problem = presetStructureProblem(ours)
  if (problem !== undefined || !Array.isArray(ours) || ours.length === 0) {
    return { outcome: { status: 'error', reason: `内置 preset 资源结构异常：${problem ?? '空列表'}` }, mergedText: undefined }
  }
  // 源声明行与已安装声明行必须同层比较：源本身也经 findPresetRows 定位
  //（源是 `- insert:` 包裹形状时顶层首行是外壳，直接比较会永不等）。
  const ourRefs = findPresetRows(ours)
  if (ourRefs.length !== 1) {
    return { outcome: { status: 'error', reason: '内置 preset 资源中 preset-manager 声明不是恰好一处' }, mergedText: undefined }
  }
  const ourCanonical = canonicalJson(presetRowOf(ours as unknown[], ourRefs[0]!))
  if (!existsSync(target)) {
    if (dryRun) return { outcome: { status: 'dry-run-write' }, mergedText: presetSourceText }
    mkdirSync(home, { recursive: true })
    writeFileSync(target, presetSourceText.endsWith('\n') ? presetSourceText : `${presetSourceText}\n`, 'utf8')
    return { outcome: { status: 'installed' }, mergedText: presetSourceText }
  }
  let currentText: string
  try {
    currentText = readFileSync(target, 'utf8')
  } catch (error) {
    return { outcome: { status: 'error', reason: `无法读取 ${target}：${String(error)}` }, mergedText: undefined }
  }
  if (currentText.trim() === '') {
    if (dryRun) return { outcome: { status: 'dry-run-write' }, mergedText: presetSourceText }
    writeFileSync(target, presetSourceText.endsWith('\n') ? presetSourceText : `${presetSourceText}\n`, 'utf8')
    return { outcome: { status: 'installed' }, mergedText: presetSourceText }
  }
  let current: unknown
  try {
    current = parseDocument(currentText).toJS()
  } catch (error) {
    return { outcome: { status: 'error', reason: `${target} 解析失败，未改动：${String(error)}` }, mergedText: undefined }
  }
  const listProblem = presetStructureProblem(current)
  if (listProblem !== undefined || !Array.isArray(current)) {
    return { outcome: { status: 'error', reason: `${target} 不是合法 patch 列表（${listProblem ?? '非列表'}），未改动` }, mergedText: undefined }
  }
  const rows = current as unknown[]
  const refs = findPresetRows(rows)
  if (refs.length === 0) {
    // 追加：原文逐字节保留，只在末尾补声明块。
    const merged = `${currentText.endsWith('\n') ? currentText : `${currentText}\n`}${
      presetSourceText.endsWith('\n') ? presetSourceText : `${presetSourceText}\n`}`
    if (dryRun) return { outcome: { status: 'dry-run-write' }, mergedText: merged }
    writeFileSync(target, merged, 'utf8')
    return { outcome: { status: 'installed' }, mergedText: merged }
  }
  const same = refs.length === 1 && canonicalJson(presetRowOf(rows, refs[0]!)) === ourCanonical
  if (same) return { outcome: { status: 'up-to-date' }, mergedText: currentText }
  const hint = `已有 ${refs.length} 处 id=${PRESET_ROW_ID} 声明与内置资源不同`
  if (!force) {
    return dryRun
      ? { outcome: { status: 'dry-run-skip', hint }, mergedText: currentText }
      : { outcome: { status: 'skipped-differs', hint }, mergedText: currentText }
  }
  if (dryRun) return { outcome: { status: 'dry-run-write' }, mergedText: currentText }
  // --force：备份原文件后在 Document AST 上替换同 id 声明，其余节点原样保留
  //（toJS()+stringify 重写会丢 !!js 等自定义标签与注释，备份即回退路径）。
  const backup = backupPath(target)
  writeFileSync(backup, currentText, 'utf8')
  const currentDoc = parseDocument(currentText)
  const docSeq = currentDoc.contents
  const ourDocSeq = parseDocument(presetSourceText).contents
  if (!(docSeq instanceof YAMLSeq) || !(ourDocSeq instanceof YAMLSeq) || ourDocSeq.items.length === 0) {
    return { outcome: { status: 'error', reason: `${target} 文档结构异常，未改动目标文件（原文件已备份到 ${backup}）` }, mergedText: undefined }
  }
  const ourNode = ourDocSeq.items[0] as ParsedNode
  if (refs.length === 1 && refs[0]!.kind === 'top') {
    docSeq.items[refs[0]!.index] = ourNode.clone() as ParsedNode
  } else {
    // 先删容器内嵌套声明（不影响顶层下标），再倒序删顶层行，最后追加内置声明。
    const nestedByContainer = new Map<number, number[]>()
    for (const ref of refs) {
      if (ref.kind !== 'insert') continue
      const list = nestedByContainer.get(ref.container!)
      if (list === undefined) nestedByContainer.set(ref.container!, [ref.index])
      else list.push(ref.index)
    }
    for (const [containerIndex, nestedIndexes] of nestedByContainer) {
      const container = docSeq.items[containerIndex]
      const insert = container instanceof YAMLMap ? container.get('insert', true) : undefined
      if (!(insert instanceof YAMLSeq)) {
        return { outcome: { status: 'error', reason: `${target} 文档结构异常，未改动目标文件（原文件已备份到 ${backup}）` }, mergedText: undefined }
      }
      for (const nestedIndex of [...nestedIndexes].sort((a, b) => b - a)) insert.items.splice(nestedIndex, 1)
    }
    for (const topIndex of refs.filter(ref => ref.kind === 'top').map(ref => ref.index).sort((a, b) => b - a)) {
      docSeq.items.splice(topIndex, 1)
    }
    docSeq.items.push(ourNode.clone() as ParsedNode)
  }
  const merged = currentDoc.toString()
  writeFileSync(target, merged, 'utf8')
  return { outcome: { status: 'overwritten', backup }, mergedText: merged }
}

export interface InitResult {
  ok: boolean
  text: string
}

/**
 * 执行一键安装。调用前先由 resolveInitSources 解析源（缺失即抛，零写入），
 * 源文件在写入前一次性读入内存。返回人读报告；ok=false 表示有 error/校验问题。
 */
export function runInit(home: string, sources: InitSources, options: InitOptions): InitResult {
  const lines: string[] = []
  let failed = false
  const report = (outcome: FileOutcome, label: string): void => {
    lines.push(renderFileOutcome(label, outcome, options.dryRun))
    if (outcome.status === 'error') failed = true
  }

  const wanted = options.full ? [...FULL_WORKFLOW_IDS] : [...MINIMAL_WORKFLOW_IDS]
  const selected = sources.workflows.filter(item => (wanted as readonly string[]).includes(item.id))
  if (selected.length !== wanted.length) {
    const absent = wanted.filter(id => !selected.some(item => item.id === id))
    return { ok: false, text: `安装源不完整（未写入任何文件）：缺少 ${absent.join('、')}` }
  }
  // 源先全部读入：任一源读不出则零写入。
  let presetSourceText: string
  const workflowBytes = new Map<string, Buffer>()
  try {
    presetSourceText = readFileSync(sources.presetFile, 'utf8')
  } catch (error) {
    return { ok: false, text: `安装源不可读（未写入任何文件）：${sources.presetFile}：${String(error)}` }
  }
  for (const item of selected) {
    if (!ID_PATTERN.test(item.id) || basename(item.source, '.yaml') !== item.id) {
      return { ok: false, text: `安装源异常（未写入任何文件）：${item.source} 与 id ${item.id} 不一致` }
    }
    try {
      workflowBytes.set(item.id, readFileSync(item.source))
    } catch (error) {
      return { ok: false, text: `安装源不可读（未写入任何文件）：${item.source}：${String(error)}` }
    }
  }

  lines.push(`目标 home：${home}（${options.full ? '全量' : '最小集'}${options.force ? '，强制覆盖' : ''}${options.dryRun ? '，预演' : ''}）`)
  lines.push('## 工作流')
  // 装后校验只覆盖本轮落盘的字节（installed/overwritten/up-to-date 与源一致，
  // 校验必过）：skipped-differs 是用户所有的文件，跳过行已说明归属，不再拿
  // 用户定制按模板校验（否则用户重跑永远 ok=false，不敢重跑）。
  const verifyTargets: string[] = []
  for (const item of selected) {
    const target = join(home, CATALOG_DIR_NAME, `${item.id}.yaml`)
    const outcome = applyFileBytes(target, workflowBytes.get(item.id)!, options.force, options.dryRun)
    report(outcome, `workflows/${item.id}.yaml`)
    if (outcome.status === 'installed' || outcome.status === 'overwritten' || outcome.status === 'up-to-date') {
      verifyTargets.push(item.id)
    }
  }
  lines.push('## 通用 Manager preset')
  const preset = applyPreset(home, presetSourceText, options.force, options.dryRun)
  report(preset.outcome, HOME_PATCH_FILENAME)

  lines.push('## 装后校验')
  if (options.dryRun) {
    lines.push('预演模式：未写入，未校验。')
  } else {
    for (const id of verifyTargets) {
      const target = join(home, CATALOG_DIR_NAME, `${id}.yaml`)
      try {
        const text = readFileSync(target, 'utf8')
        const warnings: string[] = []
        const normalized = validateAndNormalize(parseCatalogConfig(text), { workflowId: id, warnings })
        const hash = computeDefinitionHash(normalized)
        lines.push(`OK workflows/${id}.yaml（definitionHash=${hash}）`)
        for (const warning of warnings) lines.push(`WARN workflows/${id}.yaml：${warning}`)
      } catch (error) {
        failed = true
        // 问题文件只影响自身：捕获后继续校验其余文件。
        lines.push(`PROBLEM workflows/${id}.yaml：${String(error)}（只阻塞自身，见 /dsh-flow list 诊断）`)
      }
    }
    const patchTarget = join(home, HOME_PATCH_FILENAME)
    try {
      const merged = preset.mergedText ?? readFileSync(patchTarget, 'utf8')
      const parsed = parseDocument(merged).toJS()
      const structure = presetStructureProblem(parsed)
      if (structure !== undefined) {
        failed = true
        lines.push(`PROBLEM ${HOME_PATCH_FILENAME}：${structure}`)
      } else if (findPresetRows(parsed).length === 0) {
        failed = true
        lines.push(`PROBLEM ${HOME_PATCH_FILENAME}：缺少 id=${PRESET_ROW_ID} 声明`)
      } else {
        lines.push(`OK ${HOME_PATCH_FILENAME}（含 id=${PRESET_ROW_ID} 声明）`)
      }
    } catch (error) {
      failed = true
      lines.push(`PROBLEM ${HOME_PATCH_FILENAME}：${String(error)}`)
    }
  }
  lines.push(failed
    ? '完成（含错误：见上 error/PROBLEM 行，问题之外的文件不受影响）'
    : '完成。重启 DSH 后用 /dsh-flow list 核对工作流，新会话可选 manager preset。')
  return { ok: !failed, text: lines.join('\n') }
}
