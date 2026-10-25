/**
 * #252 运行监控只读布局读取：`<catalogDir>/<workflowId>/<workflowId>.layout.json`
 * 是编辑器保存的节点坐标（与配置同目录）。监控只读消费，绝不写文件、不触发目录
 * 扫描；缺失/IO 错误返回 undefined（客户端按网格补位），损坏文件回退空布局。
 *
 * 布局只是显示增强：任何失败都不影响 status 的图结构/节点状态投影。
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { catalogDir } from '../catalog/loader.ts'
import { parseLayoutFile, type EditorLayout } from '../editor/layout.ts'

/** 读取工作流布局；文件缺失或不可读 → undefined。 */
export async function readRunLayout(home: string, workflowId: string): Promise<EditorLayout | undefined> {
  try {
    const text = await readFile(join(catalogDir(home), workflowId, `${workflowId}.layout.json`), 'utf8')
    return parseLayoutFile(text).layout
  } catch {
    return undefined
  }
}
