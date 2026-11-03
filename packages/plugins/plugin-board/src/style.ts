// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
const CSS = `
.board-view { display:flex; flex-direction:column; height:100%; min-height:0; font-family:var(--font-ui,sans-serif); font-size:13px; color:var(--text,#cdd6f4); }
.board-toolbar { display:flex; gap:6px; align-items:center; padding:6px 10px; border-bottom:1px solid var(--border,#313244); }
.board-btn { border:1px solid var(--border,#313244); background:transparent; color:var(--text-muted,#a6adc8); border-radius:4px; padding:2px 10px; font:inherit; cursor:pointer; }
.board-btn-on { color:var(--text,#cdd6f4); background:color-mix(in srgb, var(--accent,#7c3aed) 18%, transparent); }
.board-spacer { flex:1; }
.board-status { font-size:11px; color:var(--text-muted,#a6adc8); }
.board-status-bad { color:var(--red,#f38ba8); }
.board-panes { flex:1; display:flex; min-height:0; }
.board-code { flex:1; min-width:0; overflow:auto; border-right:1px solid var(--border,#313244); }
.board-code .cm-editor { height:100%; font-size:12.5px; }
.board-code .cm-content, .board-code .cm-line, .board-code .cm-gutters { font-family:var(--font-mono,ui-monospace,monospace) !important; }
.board-preview { flex:1; min-width:0; position:relative; overflow:auto; }
.board-preview iframe, .board-embed iframe { border:none; width:100%; display:block; background:transparent; }
.board-preview iframe { height:100%; }
.board-confirm { position:absolute; inset:auto 12px 12px 12px; z-index:5; background:var(--bg-elevated,var(--bg-surface,#252535)); border:1px solid var(--border,#313244); border-radius:8px; padding:10px 12px; box-shadow:0 8px 24px rgba(0,0,0,0.35); font:13px var(--font-ui,sans-serif); color:var(--text,#cdd6f4); }
.board-confirm code { font-size:12px; word-break:break-all; }
.board-confirm-actions { display:flex; gap:6px; margin-top:8px; }
.board-embed { position:relative; margin:6px 0; border:1px solid color-mix(in srgb, var(--border,#313244) 70%, transparent); border-radius:6px; overflow:hidden; }
.board-embed-foot { display:flex; gap:10px; font:11px var(--font-ui,sans-serif); color:var(--text-muted,#a6adc8); padding:3px 8px; border-top:1px solid color-mix(in srgb, var(--border,#313244) 60%, transparent); }
.board-embed-foot a { color:inherit; }
`
let done = false
export function ensureStyle(): void {
  if (done || typeof document === 'undefined') return
  done = true
  const el = document.createElement('style')
  el.dataset.plugin = 'plugin-board'
  el.textContent = CSS
  document.head.appendChild(el)
}
