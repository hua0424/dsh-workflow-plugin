/**
 * web-client 最小打包：将纯 JS 客户端源拼合成宿主模块加载器 factory 格式。
 *
 * 输出（默认 web-client/dist/client.js，gitignored，不提交）：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... } });
 * 与宿主 tsdown.client.ts 的 banner/footer/intro 约定一致：
 *   intro: var module = { exports: {} }; var exports = module.exports;
 *   factory 末尾 return { PANEL_KEY, inject, apply }。
 *
 * 用法：node web-client/build.mjs [--out <目录>]
 * 约束：四源文件经正则做最小拼合（顺序 rpc → edits → panel → index，
 * 无重名顶层绑定，react 经 require('react') 取宿主共享实例）。React Flow 引入后必须切换到正式
 * bundler，本脚本即退役（见 README）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, 'src')
export const PLUGIN_ID = 'dsh-agent-team-workflow'

function read(name) {
  return readFileSync(join(srcDir, name), 'utf8')
}

/** ESM import 行 → 拼合作用域内的 require/直接引用（`X as Y` 转为 `X: Y` 解构）。 */
function rewriteImports(source, from, toExpression) {
  return source.replace(
    /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?/gm,
    (line, names, specifier) => {
      if (specifier !== from) return line
      const bindings = String(names)
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => {
          const alias = part.match(/^(\w+)\s+as\s+(\w+)$/)
          return alias !== null ? `${alias[1]}: ${alias[2]}` : part
        })
      return `const { ${bindings.join(', ')} } = ${toExpression};`
    },
  )
}

/** 剥 ESM import/export，改写为拼合作用域内的直接引用。 */
export function bundleSources() {
  const rpc = read('rpc.js').replace(/^export\s+/gm, '')
  const edits = read('edits.js').replace(/^export\s+/gm, '')
  const panel = rewriteImports(read('panel.js'), 'react', "require('react')")
  const panelLinked = rewriteImports(rewriteImports(panel, './rpc.js', '__rpc'), './edits.js', '__edits')
  const index = rewriteImports(
    rewriteImports(read('index.js'), './panel.js', '__panel'),
    './rpc.js',
    '__rpc',
  )
  return {
    rpc,
    edits,
    panel: panelLinked.replace(/^export\s+/gm, ''),
    index: index.replace(/^export\s+/gm, ''),
  }
}

export function buildClientBundle({ outDir } = {}) {
  const { rpc, edits, panel, index } = bundleSources()
  const bundle = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __rpc = (function () {
${rpc}
return { EDITOR_RPC_CHANNEL, callEditor, rpcErrorMessage };
})();
var __edits = (function () {
${edits}
return { HISTORY_LIMIT, ID_PATTERN, RESERVED_ROLE_KEYS, ROLE_REUSE_MODES, SUPPORTED_CHECKER_IDS, layoutFilenameFor, clone, isDirty, savePlanOf, snapshotOf, pushHistory, applyPersonaEdit, moveNodeEdit, undoEdit, redoEdit, addRoleEdit, setRolePersonaEdit, setRoleModelEdit, setRoleReuseEdit, setRoleDenyEdit, renameRoleEdit, deleteRoleEdit, findRoleRefs, setJudgePersonaEdit, setJudgeModelEdit, setJudgeDenyEdit, parseNewFilenameEdit, minimalConfigOf, addActorNodeEdit, setActorFieldsEdit, renameNodeEdit, deleteNodeEdit, findNodeRefsEdit, addNodeResultEdit, setNodeResultEdit, renameNodeResultEdit, deleteNodeResultEdit, setFlowStartNodeEdit, addFlowReturnEdit, renameFlowReturnEdit, deleteFlowReturnEdit };
})();
var __panel = (function () {
${panel}
return { WorkflowConfigEditorPanel, WorkflowConfigEditorIcon };
})();
${index}
return { PANEL_KEY, inject, apply }; } });\n`
  const target = outDir ?? join(here, 'dist')
  mkdirSync(target, { recursive: true })
  const outFile = join(target, 'client.js')
  writeFileSync(outFile, bundle, 'utf8')
  return outFile
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const outIndex = process.argv.indexOf('--out')
  if (outIndex !== -1 && (process.argv[outIndex + 1] === undefined || process.argv[outIndex + 1] === '')) {
    console.error('用法：node web-client/build.mjs [--out <目录>]')
    process.exit(2)
  }
  const outDir = outIndex === -1 ? undefined : resolve(process.argv[outIndex + 1] ?? '')
  console.log(`built ${buildClientBundle({ outDir })}`)
}
