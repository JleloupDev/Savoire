// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
const STYLE_ID = 'savoire-animation-style'

const CSS = `
.anim-view [hidden] { display: none !important; }
.anim-view { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--bg-base); color: var(--text); font-family: var(--font-ui, system-ui, sans-serif); }
.anim-toolbar { display: flex; align-items: center; gap: 6px; padding: 6px 10px; border-bottom: 1px solid var(--border); flex: none; flex-wrap: wrap; }
.anim-spacer { flex: 1; }
.anim-status { font-size: 12px; color: var(--text-muted); max-width: 50%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.anim-status-bad { color: var(--red, #d73a49); }
.anim-btn { border: 1px solid var(--border); background: var(--bg-surface); color: var(--text); border-radius: 5px; padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; line-height: 1.4; }
.anim-btn:hover { border-color: var(--accent); }
.anim-btn-on { background: var(--accent); border-color: var(--accent); color: var(--accent-text, #fff); }
.anim-btn:disabled { opacity: .5; cursor: default; }
.anim-panes { flex: 1; min-height: 0; display: flex; }
.anim-code { flex: 1; min-width: 0; overflow: auto; border-right: 1px solid var(--border); }
.anim-code .cm-editor { height: 100%; font-size: 13px; }
.anim-code .cm-content, .anim-code .cm-line, .anim-code .cm-gutters { font-family: var(--font-mono, ui-monospace, 'Cascadia Code', Menlo, monospace) !important; }
.anim-side { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: auto; }
.anim-stage { position: relative; padding: 12px; }
.anim-frame { display: block; width: 100%; height: 240px; border: 1px solid var(--border); border-radius: 6px; background: transparent; }
.anim-transport { display: flex; align-items: center; gap: 8px; padding: 6px 12px; }
.anim-transport-compact { padding: 4px 2px 0; gap: 6px; }
.anim-transport .anim-btn { padding: 3px 7px; }
.anim-track { position: relative; flex: 1; height: 16px; cursor: pointer; touch-action: none; }
.anim-track::before { content: ''; position: absolute; left: 0; right: 0; top: 6px; height: 4px; border-radius: 2px; background: var(--border); }
.anim-track-fill { position: absolute; left: 0; top: 6px; height: 4px; border-radius: 2px; background: var(--accent); pointer-events: none; }
.anim-track-fill::after { content: ''; position: absolute; right: -6px; top: -4px; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 0 2px var(--bg-base); }
.anim-track-marks { position: absolute; inset: 0; pointer-events: none; }
.anim-marker { all: unset; position: absolute; top: 0; width: 4px; margin-left: -2px; height: 16px; border-radius: 2px; background: #f59e0b; cursor: pointer; pointer-events: auto; opacity: .9; }
.anim-marker-range { margin-left: 0; height: 6px; top: 5px; background: rgba(245, 158, 11, .55); border: 1px solid #f59e0b; box-sizing: border-box; }
.anim-marker-done { background: var(--text-muted); opacity: .45; }
.anim-time { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--text-muted); min-width: 4.5em; text-align: right; }
.anim-review { padding: 6px 12px 12px; display: flex; flex-direction: column; gap: 6px; }
.anim-review-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; color: var(--text-muted); }
.anim-review-title { font-weight: 600; color: var(--text); margin-right: auto; }
.anim-review-list { display: flex; flex-direction: column; gap: 4px; }
.anim-comment { display: flex; gap: 8px; align-items: flex-start; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-surface); cursor: pointer; font-size: 13px; }
.anim-comment:hover { border-color: var(--accent); }
.anim-comment-done { opacity: .6; }
.anim-comment-when { font-variant-numeric: tabular-nums; color: var(--accent); white-space: nowrap; font-size: 12px; padding-top: 1px; }
.anim-comment-body { flex: 1; min-width: 0; }
.anim-comment-meta { font-size: 11px; color: var(--text-muted); }
.anim-comment-text { white-space: pre-wrap; word-break: break-word; }
.anim-card { border: 1px solid var(--border); border-radius: 6px; padding: 6px; background: var(--bg-elevated); }
.anim-empty { font-size: 12px; color: var(--text-muted); font-style: italic; }
.anim-embed { margin: 4px 0; display: flex; flex-direction: column; }
.anim-embed-stage { position: relative; flex: 0 1 auto; min-width: 0; overflow: hidden; }
.anim-embed .anim-frame { position: absolute; left: 0; top: 0; width: 100%; border: 0; border-radius: 4px; height: 160px; transform-origin: 50% 0; }
.anim-embed .anim-transport, .anim-embed-foot { flex: none; }
.anim-embed-foot { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-muted); padding-top: 2px; }
.anim-embed-foot a { color: var(--text-muted); text-decoration: none; display: inline-flex; align-items: center; gap: 4px; }
.anim-embed-foot a:hover { color: var(--accent); }
.anim-embed-error { font-size: 13px; color: var(--red, #d73a49); padding: 6px 0; }
@media (max-width: 760px) { .anim-panes { flex-direction: column; } .anim-code { border-right: 0; border-bottom: 1px solid var(--border); min-height: 40%; } }
`

export function ensureStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}
