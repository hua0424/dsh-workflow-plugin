/** 面板自包含样式：源码预览与宿主 bundle 共用，不依赖宿主全局 CSS。 */
export const EDITOR_STYLES = `
.wf-editor {
  --wf-bg: #f4f7fa; --wf-surface: #ffffff; --wf-soft: #eef3f7;
  --wf-text: #243449; --wf-muted: #65768b; --wf-border: #dbe3ec;
  --wf-accent: #0f766e; --wf-accent-soft: #e0f2ee; --wf-danger: #b42336;
  box-sizing: border-box; width: 100%; height: 100%; min-height: 0;
  display: flex; flex-direction: column; gap: 10px; padding: 18px 22px;
  overflow: auto; container-type: inline-size; color: var(--wf-text);
  background: var(--wf-bg); font: 13px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.wf-editor *, .wf-editor *::before, .wf-editor *::after { box-sizing: border-box; }
.wf-editor h2, .wf-editor h3, .wf-editor h4, .wf-editor p { margin: 0; }
.wf-editor h2 { font-size: 22px; line-height: 1.4; font-weight: 700; letter-spacing: -.5px; }
.wf-editor h3 { margin-bottom: 14px; font-size: 14px; font-weight: 650; }
.wf-editor h4 { margin: 12px 0 8px; font-size: 13px; }
.wf-editor button, .wf-editor input, .wf-editor select, .wf-editor textarea { font: inherit; }
.wf-editor button {
  min-height: 34px; padding: 6px 12px; border: 1px solid var(--wf-border); border-radius: 7px;
  background: var(--wf-surface); color: var(--wf-text); cursor: pointer; line-height: 1.45;
  transition: background .12s, border-color .12s; overflow-wrap: anywhere;
}
.wf-editor button:hover:not(:disabled) { border-color: var(--wf-accent); background: var(--wf-accent-soft); }
.wf-editor button:disabled { cursor: default; opacity: .45; }
.wf-editor :is(button, input, select, textarea, summary):focus-visible { outline: 2px solid var(--wf-accent); outline-offset: 3px; }
.wf-editor :is(input, select, textarea) {
  min-width: 0; max-width: 100%; width: 100%; padding: 7px 9px; border-radius: 6px;
  border: 1px solid var(--wf-border); color: var(--wf-text); background: var(--wf-surface);
}
.wf-editor textarea { display: block; resize: vertical; min-height: 78px; }
.wf-editor label { display: block; margin: 10px 0 5px; color: var(--wf-muted); font-size: 12px; overflow-wrap: anywhere; }
.wf-editor code { font-family: ui-monospace, Consolas, monospace; overflow-wrap: anywhere; }
.wf-editor .wf-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex: 0 0 auto; }
.wf-editor .wf-header p { color: var(--wf-muted); }
.wf-editor .wf-badge { max-width: 45%; padding: 4px 9px; border: 1px solid var(--wf-border); border-radius: 6px; background: var(--wf-surface); color: var(--wf-muted); font: 11px/1.5 ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wf-editor .wf-hint { color: var(--wf-muted); font-size: 12px; }
.wf-editor :is(.wf-toolbar, .wf-files, .wf-newfile, .wf-flows, .wf-role-list, .wf-node-list) {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
}
.wf-editor .wf-toolbar { padding: 8px 10px; border: 1px solid var(--wf-border); border-radius: 10px; background: var(--wf-surface); }
.wf-editor button.wf-primary { color: white; border-color: var(--wf-accent); background: var(--wf-accent); }
.wf-editor button.wf-primary:hover:not(:disabled) { color: var(--wf-accent); background: var(--wf-accent-soft); }
.wf-editor .wf-toolbar span { color: var(--wf-muted); font-size: 12px; }
.wf-editor .wf-files label, .wf-editor .wf-newfile label { margin: 0; }
.wf-editor .wf-files select { width: auto; max-width: 420px; flex: 1 1 220px; }
.wf-editor .wf-newfile input { width: 220px; flex: 0 1 220px; }
.wf-editor details.wf-newfile { display: block; margin: 0; padding: 6px 10px; }
.wf-editor details.wf-newfile > div { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.wf-editor :is(.wf-error, .wf-warn, .wf-saveresult, .wf-wire) {
  padding: 10px 12px; border: 1px solid var(--wf-border); border-radius: 8px; overflow-wrap: anywhere;
}
.wf-editor .wf-error { color: var(--wf-danger); background: #fff0f1; border-color: #f4c7ce; }
.wf-editor .wf-warn { color: #8a580f; background: #fff7e6; border-color: #f4ddb0; }
.wf-editor .wf-saveresult { background: var(--wf-accent-soft); }
.wf-editor .wf-wire { color: var(--wf-accent); background: var(--wf-accent-soft); }
.wf-editor .wf-wire button { margin-left: 8px; }
.wf-editor .wf-main { display: grid; grid-template-columns: minmax(0, 1fr) 320px; align-items: start; gap: 14px; min-width: 0; }
.wf-editor .wf-main.wf-inspector-collapsed { grid-template-columns: minmax(0, 1fr) 42px; }
.wf-editor .wf-inspector-toggle { display: block; width: 100%; border: 0; border-radius: 0; color: var(--wf-accent); }
.wf-editor .wf-inspector-collapsed .wf-inspector-toggle { writing-mode: vertical-rl; padding: 12px 8px; }
.wf-editor [hidden] { display: none !important; }
.wf-editor .wf-flows { grid-column: 1 / -1; padding-bottom: 2px; }
.wf-editor .wf-flows button:disabled, .wf-editor .wf-tabs button[aria-selected="true"] {
  opacity: 1; color: var(--wf-accent); border-color: var(--wf-accent); background: var(--wf-accent-soft); font-weight: 650;
}
.wf-editor .wf-flow { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.wf-editor .wf-canvas-toolbar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; min-height: 34px; }
.wf-editor .wf-flow > div:not(.wf-canvas) { color: var(--wf-muted); font-size: 12px; }
.wf-editor .wf-flow > div:not(.wf-canvas) button { margin: 0 4px 0 0; }
.wf-editor .wf-canvas {
  position: relative; height: min(72vh, 780px); min-height: 420px; overflow: hidden;
  border: 1px solid var(--wf-border); border-radius: 12px; background-color: var(--wf-surface);
  background-image: radial-gradient(var(--wf-border) 1px, transparent 1px); background-size: 20px 20px;
  overscroll-behavior: contain;
}
.wf-editor .wf-canvas-surface { position: relative; min-width: 100%; min-height: 100%; }
.wf-editor .wf-canvas.wf-panning { cursor: grabbing; user-select: none; }
.wf-editor .wf-edges { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.wf-editor .wf-edges path { fill: none; stroke: #8195aa; stroke-width: 2; }
.wf-editor .wf-edges .wf-edge-selected path { stroke: var(--wf-accent); stroke-width: 3; }
.wf-editor .wf-edges .wf-edge .wf-edge-hit { stroke: transparent; stroke-width: 14; pointer-events: stroke; cursor: pointer; }
.wf-editor .wf-edges .wf-edge-hit:focus-visible { stroke: var(--wf-accent); stroke-opacity: .25; outline: none; }
.wf-editor .wf-edge-handle { fill: var(--wf-surface); stroke: var(--wf-accent); stroke-width: 2; pointer-events: all; touch-action: none; }
.wf-editor .wf-edge-handle-x { cursor: ew-resize; }
.wf-editor .wf-edge-handle-y { cursor: ns-resize; }
.wf-editor .wf-edge-handle:focus-visible { outline: 2px solid var(--wf-accent); outline-offset: 3px; }
.wf-editor .wf-edges marker path { fill: #8195aa; stroke: none; }
.wf-editor .wf-edges text { fill: var(--wf-muted); font-size: 11px; }
.wf-editor .wf-node {
  position: absolute; width: 196px; border-radius: 9px; background: var(--wf-surface);
  box-shadow: 0 0 0 1px var(--wf-border), 0 4px 10px #2032480d; overflow: hidden;
}
.wf-editor .wf-node.wf-selected { box-shadow: 0 0 0 2px var(--wf-accent), 0 6px 16px #0f766e16; }
.wf-editor .wf-node-title {
  display: flex; align-items: center; width: 100%; height: 44px; min-height: 44px; padding: 0 12px;
  border: 0; border-radius: 0; border-bottom: 1px solid var(--wf-border); background: var(--wf-soft);
  color: var(--wf-text); font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  cursor: grab; touch-action: none; user-select: none; text-align: left;
}
.wf-editor .wf-node-title:active { cursor: grabbing; }
.wf-editor .wf-node-type { height: 28px; padding: 5px 12px; font-size: 11px; font-weight: 650; color: var(--wf-accent); background: var(--wf-accent-soft); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wf-editor .wf-port-label { display: inline-block; margin-right: 6px; font-size: 10px; color: var(--wf-muted); font-weight: 400; }
.wf-editor .wf-port {
  display: block; width: 100%; height: 32px; min-height: 32px; border: 0; border-radius: 0;
  padding: 6px 12px; background: transparent; color: var(--wf-muted); text-align: left;
  font-size: 12px; line-height: 20px; cursor: crosshair; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.wf-editor .wf-port.wf-wiring { background: var(--wf-accent-soft); color: var(--wf-accent); }
.wf-editor .wf-pos { padding: 5px 12px; font: 10px/1.5 ui-monospace, monospace; color: var(--wf-muted); border-top: 1px solid var(--wf-border); }
.wf-editor .wf-return-marker { position: absolute; width: 150px; height: 36px; border: 1px solid var(--wf-accent); border-radius: 18px; color: var(--wf-accent); background: var(--wf-accent-soft); }
.wf-editor .wf-return-marker:disabled { opacity: 1; }
.wf-editor .wf-inspector { min-width: 0; border: 1px solid var(--wf-border); border-radius: 12px; background: var(--wf-surface); overflow: hidden; }
.wf-editor .wf-tabs { display: flex; gap: 4px; padding: 8px; border-bottom: 1px solid var(--wf-border); background: var(--wf-soft); }
.wf-editor .wf-tabs button { flex: 1; padding: 6px; border-color: transparent; background: transparent; }
.wf-editor .wf-inspector-content { min-width: 0; max-height: min(72vh, 780px); overflow: auto; padding: 18px; overscroll-behavior: contain; }
.wf-editor .wf-inspector-content > div:not([hidden]) > div + div { margin-top: 20px; }
.wf-editor .wf-inspector-content :is(.wf-role-card, .wf-node-card, .wf-judge, .wf-flowconf, .wf-subflows, .wf-child-card) > div { margin-bottom: 14px; }
.wf-editor .wf-inspector-content button { margin: 6px 5px 0 0; font-size: 12px; }
.wf-editor .wf-inspector-content :is(.wf-role-list, .wf-node-list) { margin: 14px 0; }
.wf-editor .wf-inspector-content :is(.wf-role-list, .wf-node-list) button { margin: 0; }
.wf-editor .wf-inspector-content :is(.wf-role-list, .wf-node-list) button:disabled { opacity: 1; color: var(--wf-accent); background: var(--wf-accent-soft); }
.wf-editor details { margin-bottom: 10px; padding: 10px 12px; border: 1px solid var(--wf-border); border-radius: 8px; }
.wf-editor summary { color: var(--wf-accent); cursor: pointer; font-weight: 600; }
.wf-editor details[open] summary { margin-bottom: 12px; }
.wf-editor :is(.wf-result-row, .wf-result-new, .wf-return) { display: block; margin: 12px 0; padding: 12px; background: var(--wf-soft); border-radius: 8px; }
.wf-editor .wf-preview pre { margin: 12px 0 0; padding: 12px; overflow: auto; border-radius: 8px; background: var(--wf-soft); font: 12px/1.7 ui-monospace, Consolas, monospace; }
.wf-editor .wf-inspector-content :is(div, span, details):has(> label),
.wf-editor .wf-result-rename, .wf-editor .wf-return { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; }
.wf-editor .wf-inspector-content :is(div, span, details):has(> label) > :is(label, summary, div:not(.wf-long-text), span, code) { flex-basis: 100%; }
.wf-editor .wf-inspector-content :is(div, span, details):has(> label) > label { margin: 8px 0 0; }
.wf-editor .wf-inspector-content :is(div, span, details):has(> label) > :is(input, select),
.wf-editor :is(.wf-result-rename, .wf-return) > input { width: auto; flex: 1 1 100px; }
.wf-editor .wf-inspector-content :is(div, span, details):has(> label) > button,
.wf-editor :is(.wf-result-rename, .wf-return) > button { margin: 0; flex: 0 0 auto; }
.wf-editor .wf-long-text { min-width: 0; flex: 1 1 170px; }
.wf-editor button.wf-text-preview { display: block; width: 100%; margin: 0; text-align: left; white-space: pre-wrap; overflow: hidden; max-height: 76px; font-family: ui-monospace, Consolas, monospace; }
.wf-editor .wf-text-dialog { width: min(1000px, 92vw); max-width: 92vw; height: min(780px, 88vh); max-height: 88vh; padding: 22px; border: 1px solid var(--wf-border); border-radius: 12px; color: var(--wf-text); background: var(--wf-surface); }
.wf-editor .wf-text-dialog[open] { display: flex; flex-direction: column; gap: 14px; }
.wf-editor .wf-text-dialog::backdrop { background: #10203088; }
.wf-editor .wf-text-dialog textarea { flex: 1; min-height: 0; resize: none; white-space: pre; overflow: auto; tab-size: 2; font: 14px/1.7 ui-monospace, Consolas, monospace; }
.wf-editor .wf-dialog-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
.wf-editor .wf-dialog-actions .wf-hint { flex: 1; }
.wf-editor .wf-empty { padding: 64px 24px; border: 1px dashed var(--wf-border); border-radius: 12px; background: var(--wf-surface); color: var(--wf-muted); text-align: center; }
@container (max-width: 880px) {
  .wf-editor .wf-main { grid-template-columns: minmax(0, 1fr); }
  .wf-editor .wf-canvas { height: 460px; }
  .wf-editor .wf-inspector-content { min-width: 0; max-height: 560px; }
}
@media (prefers-color-scheme: dark) {
  .wf-editor { --wf-bg: #141c27; --wf-surface: #1d2836; --wf-soft: #243243; --wf-text: #e0e8f0; --wf-muted: #9eafc2; --wf-border: #36465a; --wf-accent: #5fd2c0; --wf-accent-soft: #173e3b; --wf-danger: #ffabb7; color-scheme: dark; }
  .wf-editor button.wf-primary { color: #102b29; }
  .wf-editor .wf-error { background: #451f2b; border-color: #793847; }
  .wf-editor .wf-warn { color: #f5cf84; background: #3e321d; border-color: #6b5531; }
}
`
