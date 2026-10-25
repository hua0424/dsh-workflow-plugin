/**
 * #252 共享流程画布：从配置编辑器 panel.js 抽出的节点/连线画布（渲染 + 拖拽/
 * 缩放/平移），配置编辑器与运行监控共用，避免第二套画布实现漂移。
 *
 * 监控只读用法：`readOnly` 关闭编辑交互（拖动/连线/端口点击），节点点击仍回调
 * `onSelectNode`（监控用于下钻子流程）；`decorations[nodeId]` 叠加运行态徽标
 * （className/badge/detail），不改图数据；平移/缩放/适应画布仍可用。
 */
import { createElement as h, useEffect, useRef, useState } from 'react'

const noop = () => {}

export function targetLabel(target) {
  if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
    if (typeof target.node === 'string') return `→ 节点 ${target.node}`
    if (typeof target.return === 'string') return `→ 返回 ${target.return}`
  }
  return '→ 未知目标'
}

export function nodeSummary(node) {
  const execution = node.execution ?? {}
  if (execution.type === 'actor-task') return `Actor/${execution.role ?? '?'}`
  if (execution.type === 'builtin-program') return `Program/${execution.programId ?? '?'}`
  if (execution.type === 'child-workflow') return `Child/${execution.workflowId ?? '?'}`
  return '未知类型'
}

export function portsOf(node) {
  if (node.results !== null && typeof node.results === 'object' && !Array.isArray(node.results)) {
    return Object.entries(node.results).map(([name, result]) => ({
      key: name,
      label: `${name} · ${result?.criteria ?? ''} · ${targetLabel(result?.target)}`,
    }))
  }
  if (node.onReturn !== null && typeof node.onReturn === 'object' && !Array.isArray(node.onReturn)) {
    return Object.entries(node.onReturn).map(([name, target]) => ({
      key: name,
      label: `${name} ${targetLabel(target)}`,
    }))
  }
  return []
}

export function NodeCanvas(props) {
  const { flowId, def, positions, startNode, returns = [], onMove = noop, busy } = props
  const { selectedNode = null, wire = null, onSelectNode = noop, onPortStart = noop, onWireNode = noop, onWireReturn = noop, onCancelWire = noop, decorations = {}, readOnly = false } = props
  const dragRef = props.dragRef ?? { current: null }
  const [dragPosition, setDragPosition] = useState(null)
  const [zoom, setZoom] = useState(1)
  const [camera, setCamera] = useState({ x: 0, y: 0 })
  const [selectedEdge, setSelectedEdge] = useState(null)
  const edgeDragRef = useRef(null)
  const viewportRef = useRef(null)
  const panRef = useRef(null)
  const suppressClick = useRef(false)
  const nodes = Object.entries(def.nodes ?? {})
  const nodePoint = (id) => positions[id] ?? { x: 40 + (Math.max(0, nodes.findIndex(([key]) => key === id)) % 4) * 220, y: 40 + Math.floor(Math.max(0, nodes.findIndex(([key]) => key === id)) / 4) * 140 }
  const returnX = Math.max(360, ...nodes.map(([id]) => nodePoint(id).x + 270))
  const point = (id) => dragPosition?.id === id ? dragPosition.pos : positions[id] ?? (id.startsWith('return:') ? { x: returnX, y: 40 + returns.indexOf(id.slice(7)) * 64 } : nodePoint(id))
  const itemIds = [...nodes.map(([id]) => id), ...returns.map((ret) => `return:${ret}`)]
  // 视口平移与节点的世界坐标分离，空白区域没有滚动边界。
  const displayPoint = point
  // 运行态徽标/原因行会撑高节点；连线路由与画布高度按同样增量下移（#252）。
  const decorationExtra = (id) => {
    const decoration = decorations[id]
    if (decoration === undefined) return 0
    return (decoration.badge ? 20 : 0) + (decoration.detail ? 18 : 0)
  }
  const width = Math.max(570, ...itemIds.map((id) => displayPoint(id).x + 240))
  const height = Math.max(420, ...returns.map((ret) => displayPoint(`return:${ret}`).y + 80), ...nodes.map(([id, node]) => displayPoint(id).y + 100 + decorationExtra(id) + portsOf(node).length * 32))
  const onPointerDown = (event, nodeId) => {
    if (busy || readOnly || wire !== null || event.button !== 0) return
    const start = point(nodeId)
    suppressClick.current = false
    dragRef.current = { nodeId, startX: event.clientX, startY: event.clientY, origin: start, pos: start }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event, nodeId) => {
    const drag = dragRef.current
    if (drag === null || drag.nodeId !== nodeId) return
    const dx = (event.clientX - drag.startX) / zoom
    const dy = (event.clientY - drag.startY) / zoom
    if (!suppressClick.current && Math.abs(dx) + Math.abs(dy) < 4) return
    suppressClick.current = true
    drag.pos = { x: Math.round(drag.origin.x + dx), y: Math.round(drag.origin.y + dy) }
    setDragPosition({ id: nodeId, pos: drag.pos })
  }
  const endDrag = (cancelled) => {
    const drag = dragRef.current
    dragRef.current = null
    setDragPosition(null)
    // 一次拖动只写一条历史，避免每个 pointermove 克隆完整配置并挤满撤销栈。
    if (!cancelled && drag !== null && suppressClick.current) onMove(flowId, drag.nodeId, drag.pos)
  }
  const selectNode = (nodeId) => {
    if (busy || suppressClick.current) { suppressClick.current = false; return }
    // 只读运行图仍允许 onSelectNode 回调（监控用它下钻子流程），但不进入编辑选择/连线。
    if (readOnly) { onSelectNode(nodeId); return }
    if (wire !== null) onWireNode(nodeId)
    else onSelectNode(nodeId)
  }
  const fit = () => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const elements = viewport.querySelectorAll('.wf-node, .wf-return-marker')
    // 使用真实内容边界；节点整体位于远处时不把世界原点纳入范围。
    const bounds = itemIds.map((id, index) => ({ ...point(id), width: elements[index]?.offsetWidth ?? 196, height: elements[index]?.offsetHeight ?? 100 }))
    const left = bounds.length ? Math.min(...bounds.map((item) => item.x)) : 0
    const top = bounds.length ? Math.min(...bounds.map((item) => item.y)) : 0
    const contentWidth = Math.max(1, ...bounds.map((item) => item.x + item.width - left))
    const contentHeight = Math.max(1, ...bounds.map((item) => item.y + item.height - top))
    const nextZoom = Math.min(1, Math.max(1, viewport.clientWidth - 48) / contentWidth, Math.max(1, viewport.clientHeight - 48) / contentHeight)
    setZoom(nextZoom)
    setCamera({ x: 24 - left * nextZoom, y: 24 - top * nextZoom })
  }
  useEffect(() => { fit(); setSelectedEdge(null) }, [flowId])
  useEffect(() => {
    const viewport = viewportRef.current
    const panWheel = (event) => {
      if (event.ctrlKey || event.metaKey) return
      event.preventDefault()
      setCamera((value) => ({ x: value.x - event.deltaX - (event.shiftKey ? event.deltaY : 0), y: value.y - (event.shiftKey ? 0 : event.deltaY) }))
    }
    viewport?.addEventListener('wheel', panWheel, { passive: false })
    return () => viewport?.removeEventListener('wheel', panWheel)
  }, [])
  const changeZoom = (nextZoom) => {
    const viewport = viewportRef.current
    const center = { x: (viewport?.clientWidth ?? 0) / 2, y: (viewport?.clientHeight ?? 0) / 2 }
    setCamera({ x: center.x - (center.x - camera.x) * nextZoom / zoom, y: center.y - (center.y - camera.y) * nextZoom / zoom })
    setZoom(nextZoom)
  }
  const startEdgeDrag = (event, key, route, axis) => {
    if (busy || readOnly || wire !== null || event.button !== 0) return
    event.stopPropagation()
    event.preventDefault()
    edgeDragRef.current = { key, axis, x: event.clientX, y: event.clientY, origin: route, pos: route, moved: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveEdge = (event) => {
    const drag = edgeDragRef.current
    if (drag === null) return
    const delta = (drag.axis === 'x' ? event.clientX - drag.x : event.clientY - drag.y) / zoom
    if (!drag.moved && Math.abs(delta) < 3) return
    drag.moved = true
    drag.pos = { ...drag.origin, [drag.axis]: Math.round(drag.origin[drag.axis] + delta) }
    setDragPosition({ id: drag.key, pos: drag.pos })
  }
  const endEdgeDrag = (cancelled) => {
    const drag = edgeDragRef.current
    edgeDragRef.current = null
    setDragPosition(null)
    if (!cancelled && drag?.moved) onMove(flowId, drag.key, drag.pos)
  }
  return h('section', { className: `wf-flow${readOnly ? ' wf-readonly' : ''}`, 'aria-label': readOnly ? '运行图（只读）' : '工作流画布' },
    h('div', { className: 'wf-canvas-toolbar' },
      h('div', null, h('strong', null, flowId === null ? '主流程' : flowId), h('span', { className: 'wf-hint' }, ` · ${nodes.length} 个节点`)),
      h('div', null,
        h('button', { onClick: () => changeZoom(Math.max(Math.min(0.25, zoom), zoom - 0.1)), 'aria-label': '缩小画布' }, '−'),
        h('button', { onClick: () => changeZoom(1), title: '恢复原始大小' }, `${Math.round(zoom * 100)}%`),
        h('button', { onClick: () => changeZoom(Math.min(1.5, zoom + 0.1)), 'aria-label': '放大画布' }, '＋'),
        h('button', { onClick: fit }, '适应画布'),
      ),
    ),
    wire !== null ? h('div', { className: 'wf-wire', role: 'status' },
      h('span', null, `${wire.node} · ${wire.result} → 请选择目标节点或返回`),
      h('button', { onClick: onCancelWire }, '取消连线'),
    ) : null,
    h('div', {
      className: 'wf-canvas', ref: viewportRef,
      style: { backgroundPosition: `${camera.x}px ${camera.y}px`, backgroundSize: `${20 * zoom}px ${20 * zoom}px` },
      onClick: (event) => { if (!event.target.closest('.wf-node, .wf-return-marker, .wf-edge')) setSelectedEdge(null) },
      onPointerDown: (event) => {
        if ((event.button !== 1 && event.button !== 2) || event.target.closest('.wf-node, .wf-return-marker')) return
        event.preventDefault()
        const viewport = event.currentTarget
        panRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: camera }
        viewport.setPointerCapture(event.pointerId)
        viewport.classList.add('wf-panning')
      },
      onPointerMove: (event) => {
        const pan = panRef.current
        if (pan === null || pan.id !== event.pointerId) return
        setCamera({ x: pan.origin.x + event.clientX - pan.x, y: pan.origin.y + event.clientY - pan.y })
      },
      onPointerUp: (event) => {
        if (panRef.current?.id !== event.pointerId) return
        event.currentTarget.releasePointerCapture(event.pointerId)
      },
      onLostPointerCapture: (event) => {
        if (panRef.current?.id !== event.pointerId) return
        panRef.current = null
        event.currentTarget.classList.remove('wf-panning')
      },
      onContextMenu: (event) => {
        if (!event.target.closest('.wf-node, .wf-return-marker')) event.preventDefault()
      },
      onAuxClick: (event) => {
        if (!event.target.closest('.wf-node, .wf-return-marker')) event.preventDefault()
      },
    },
      h('div', { style: { position: 'absolute', inset: 0 } },
        h('div', { className: 'wf-canvas-surface', style: { width: `${width}px`, height: `${height}px`, transform: `translate(${camera.x}px, ${camera.y}px) scale(${zoom})`, transformOrigin: 'top left' } },
          h('svg', { className: 'wf-edges', width, height, 'aria-label': '节点连线' },
            ...nodes.flatMap(([id, node]) => portsOf(node).map((port, index) => {
              const target = node.results?.[port.key]?.target ?? node.onReturn?.[port.key]
              const source = displayPoint(id)
              const targetIndex = returns.indexOf(target?.return)
              const destination = target?.node !== undefined && def.nodes[target.node] !== undefined
                ? { x: displayPoint(target.node).x, y: displayPoint(target.node).y + 22 }
                : targetIndex >= 0 ? { x: displayPoint(`return:${target.return}`).x, y: displayPoint(`return:${target.return}`).y + 16 } : null
              if (destination === null) return null
              const x = source.x + 196, y = source.y + 88 + decorationExtra(id) + index * 32
              const key = `edge:${id}:${port.key}`
              const backward = destination.x < x + 48
              const route = dragPosition?.id === key ? dragPosition.pos : positions[key] ?? {
                x: backward ? x + 36 + index * 12 : (x + destination.x) / 2,
                y: backward ? Math.max(source.y + 100 + decorationExtra(id) + portsOf(node).length * 32, destination.y + 64) : destination.y,
              }
              const leadX = destination.x - 24
              const path = `M ${x} ${y} H ${route.x} V ${route.y} H ${leadX} V ${destination.y} H ${destination.x}`
              const selected = selectedEdge === key
              return h('g', { key, className: `wf-edge${selected ? ' wf-edge-selected' : ''}`, 'data-edge': key },
                h('path', { d: path, className: 'wf-edge-line', fill: 'none' }),
                h('path', { d: `M ${destination.x - 7} ${destination.y - 4} L ${destination.x} ${destination.y} L ${destination.x - 7} ${destination.y + 4}`, fill: 'none' }),
                h('path', { d: path, className: 'wf-edge-hit', tabIndex: readOnly ? -1 : 0, role: 'button', 'aria-label': `选择连线 ${id} ${port.key}`, 'aria-pressed': selected,
                  onClick: (event) => { event.stopPropagation(); if (!readOnly) setSelectedEdge(key) },
                  onKeyDown: (event) => { if (!readOnly && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); setSelectedEdge(key) } },
                }),
                ...(selected && !readOnly ? [
                  { axis: 'x', cx: route.x, cy: (y + route.y) / 2, label: '左右拖动竖直线段' },
                  { axis: 'y', cx: (route.x + leadX) / 2, cy: route.y, label: '上下拖动水平线段' },
                ].map((handle) => h('circle', {
                  key: handle.axis, className: `wf-edge-handle wf-edge-handle-${handle.axis}`, cx: handle.cx, cy: handle.cy, r: 6,
                  tabIndex: busy ? -1 : 0, role: 'button', 'aria-label': `${handle.label}（方向键调整，Shift 加速）`, 'aria-disabled': busy,
                  onPointerDown: (event) => startEdgeDrag(event, key, route, handle.axis), onPointerMove: moveEdge,
                  onPointerUp: () => endEdgeDrag(false), onPointerCancel: () => endEdgeDrag(true), onLostPointerCapture: () => endEdgeDrag(true),
                  onClick: (event) => event.stopPropagation(),
                  onKeyDown: (event) => {
                    const keys = handle.axis === 'x' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
                    const direction = keys.indexOf(event.key)
                    if (direction < 0) return
                    event.preventDefault()
                    event.stopPropagation()
                    if (busy || wire !== null) return
                    onMove(flowId, key, { ...route, [handle.axis]: route[handle.axis] + (direction === 0 ? -1 : 1) * (event.shiftKey ? 40 : 10) })
                  },
                }, h('title', null, handle.label))) : []),
              )
            })),
          ),
          ...nodes.map(([nodeId, node]) => {
            const pos = displayPoint(nodeId)
            const decoration = decorations[nodeId]
            return h('div', {
              key: nodeId, className: `wf-node${nodeId === selectedNode ? ' wf-selected' : ''}${decoration?.className ? ` ${decoration.className}` : ''}${decoration?.redo ? ' wf-node-redo' : ''}`,
              style: { left: `${pos.x}px`, top: `${pos.y}px` },
              onClick: () => selectNode(nodeId),
            },
              h('button', {
                className: 'wf-node-title', disabled: busy, 'aria-label': `${readOnly ? '查看' : '编辑'}节点 ${nodeId}`,
                onPointerDown: (event) => onPointerDown(event, nodeId),
                onPointerMove: (event) => onPointerMove(event, nodeId),
                onPointerUp: () => endDrag(false), onPointerCancel: () => endDrag(true),
                title: readOnly ? '只读运行图节点' : '点击编辑，拖动调整位置',
              }, `${nodeId}${nodeId === startNode ? ' ★' : ''}`),
              h('div', { className: 'wf-node-type', title: nodeSummary(node) }, nodeSummary(node)),
              decoration?.badge ? h('div', { className: 'wf-node-state' }, decoration.badge) : null,
              decoration?.detail ? h('div', { className: 'wf-node-detail', title: decoration.detail }, decoration.detail) : null,
              ...portsOf(node).map((port) => h('button', {
                key: port.key,
                className: `wf-port${wire !== null && wire.node === nodeId && wire.result === port.key ? ' wf-wiring' : ''}`,
                disabled: busy,
                onClick: (event) => { event.stopPropagation(); if (!readOnly) onPortStart(nodeId, port.key) },
                title: readOnly ? port.label : `${port.label}；点击后选择目标节点或返回`,
              }, h('span', { className: 'wf-port-label', 'aria-hidden': true }, '结果'), `${port.key} → ${node.results?.[port.key]?.target?.node ?? node.results?.[port.key]?.target?.return ?? node.onReturn?.[port.key]?.node ?? node.onReturn?.[port.key]?.return ?? '未连接'}`)),
            )
          }),
          ...returns.map((ret) => h('button', {
            key: ret, className: 'wf-return-marker', style: { position: 'absolute', left: `${displayPoint(`return:${ret}`).x}px`, top: `${displayPoint(`return:${ret}`).y}px`, touchAction: 'none', cursor: wire === null ? 'grab' : 'pointer' },
            onPointerDown: (event) => onPointerDown(event, `return:${ret}`),
            onPointerMove: (event) => onPointerMove(event, `return:${ret}`),
            onPointerUp: () => endDrag(false), onPointerCancel: () => endDrag(true),
            onClick: () => { if (readOnly) return; if (suppressClick.current) { suppressClick.current = false; return }; if (wire !== null) onWireReturn(ret) }, disabled: busy,
            title: readOnly ? `返回 ${ret}` : wire === null ? '拖动调整结束节点位置；点击结果端口后可连接到此处' : `连接到返回 ${ret}`,
          }, `⇥ ${ret}`)),
        ),
      ),
    ),
    h('div', { className: 'wf-canvas-help' }, readOnly
      ? '只读运行图 · 空白处右键/中键平移 · 滚轮平移 · 缩放按钮调整视图 · ★ 入口'
      : '空白处右键/中键自由平移 · 滚轮平移 · 拖动标题移动节点 · 点击连线高亮，拖动圆点调整折线 · ★ 入口'),
  )
}
