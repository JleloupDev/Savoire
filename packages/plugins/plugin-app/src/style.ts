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
