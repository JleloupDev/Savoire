// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Styles des applications : ceux des boards (barre, boutons, code), plus les leurs.
import { ensureBoardStyle } from '@savoire/plugin-board'

const CSS = `
.app-view .board-preview { overflow:hidden; background:var(--bg-base,transparent); }
.app-view:fullscreen { background:var(--bg-base,#fff); }
.app-workers { display:inline-flex; gap:6px; align-items:center; font-size:11px; color:var(--text-muted,#a6adc8); }
.app-workers[hidden] { display:none; }
.app-workers b { color:var(--accent,#7c3aed); font-weight:600; }
.app-view--tab { position:fixed; inset:0; z-index:2147483000; background:var(--bg-base,#fff); }
.app-view--tab > .board-toolbar { display:none; }
.app-tab-exit { display:none; position:absolute; top:10px; right:10px; z-index:2; width:30px; height:30px; border-radius:15px; border:1px solid var(--border,#313244);
  background:color-mix(in srgb, var(--bg-elevated,#fff) 85%, transparent); color:var(--text,#1e1e2e); font:16px/1 var(--font-ui,sans-serif); cursor:pointer;
  opacity:.45; box-shadow:0 2px 10px rgba(0,0,0,.18); transition:opacity .15s; }
.app-tab-exit:hover, .app-tab-exit:focus-visible { opacity:1; }
.app-view--tab .app-tab-exit { display:block; }
.app-code-view { display:flex; flex-direction:column; height:100%; min-height:0; }
.app-code-view .board-code { border-right:none; }
`
let done = false
export function ensureAppStyle(): void {
  ensureBoardStyle()
  if (done || typeof document === 'undefined') return
  done = true
  const el = document.createElement('style')
  el.dataset.plugin = 'plugin-app'
  el.textContent = CSS
  document.head.appendChild(el)
}
