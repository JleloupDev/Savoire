// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Styles de la vue d'une base, poses une fois dans le document. Couleurs de
// l'appli (variables CSS du theme).
const CSS = `
.base-view { display:flex; flex-direction:column; height:100%; min-height:0; font-family:var(--font-ui,sans-serif); font-size:13px; color:var(--text,#cdd6f4); position:relative; }
.base-toolbar { display:flex; flex-direction:column; gap:6px; padding:8px 12px 6px; border-bottom:1px solid var(--border,#313244); flex-shrink:0; }
.base-tabs { display:flex; gap:4px; flex-wrap:wrap; }
.base-tab { border:1px solid transparent; background:transparent; color:var(--text-muted,#a6adc8); padding:3px 10px; border-radius:6px; cursor:pointer; font:inherit; }
.base-tab:hover { background:var(--bg-hover,rgba(255,255,255,0.06)); }
.base-tab-active { color:var(--text,#cdd6f4); border-color:var(--border,#313244); background:var(--bg-surface,#252535); }
.base-tab-input { font:inherit; padding:2px 6px; width:140px; }
.base-actions { display:flex; gap:4px; align-items:center; flex-wrap:wrap; }
.base-btn { border:1px solid var(--border,#313244); background:transparent; color:var(--text-muted,#a6adc8); padding:2px 8px; border-radius:5px; cursor:pointer; font:inherit; font-size:12px; }
.base-btn:hover:not(:disabled) { color:var(--text,#cdd6f4); }
.base-btn:disabled { opacity:0.45; cursor:default; }
.base-btn-on { color:var(--text,#cdd6f4); background:color-mix(in srgb, var(--accent,#7c3aed) 18%, transparent); }
.base-spacer { flex:1; }
.base-state { font-size:11.5px; color:var(--color-warn,#d19a2f); }
.base-popover { position:absolute; top:74px; z-index:30; background:var(--bg-elevated,var(--bg-surface,#252535)); border:1px solid var(--border,#313244); border-radius:8px; padding:8px; box-shadow:0 8px 24px rgba(0,0,0,0.35); min-width:260px; max-width:560px; }
.base-pop-list { display:flex; flex-direction:column; gap:6px; }
.base-pop-row { display:flex; gap:6px; align-items:center; }
.base-pop-label { flex:1; }
.base-pop-sub { font-size:11px; color:var(--text-faint,#6c7086); text-transform:uppercase; letter-spacing:0.04em; margin-top:4px; }
.base-input { background:var(--bg-base,#1e1e2e); color:var(--text,#cdd6f4); border:1px solid var(--border,#313244); border-radius:4px; padding:2px 6px; font:inherit; font-size:12px; }
.base-menu { display:flex; flex-direction:column; min-width:200px; }
.base-menu-item { text-align:left; border:none; background:transparent; color:var(--text,#cdd6f4); padding:4px 8px; border-radius:4px; cursor:pointer; font:inherit; }
.base-menu-item:hover:not(:disabled) { background:var(--bg-hover,rgba(255,255,255,0.08)); }
.base-menu-item:disabled { opacity:0.45; }
.base-menu-sub { font-size:11px; color:var(--text-faint,#6c7086); padding:6px 8px 2px; }
.base-body { flex:1; min-height:0; display:flex; }
.base-table { flex:1; overflow:auto; position:relative; }
.base-thead { position:sticky; top:0; z-index:2; display:flex; background:var(--bg-base,#1e1e2e); border-bottom:1px solid var(--border,#313244); }
.base-th { position:relative; flex:0 0 auto; padding:0; border-right:1px solid var(--border,#313244); box-sizing:border-box; }
.base-th-label { width:100%; text-align:left; border:none; background:transparent; color:var(--text-muted,#a6adc8); padding:6px 8px; font:inherit; font-weight:600; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.base-th-grip { position:absolute; right:-3px; top:0; bottom:0; width:6px; cursor:col-resize; z-index:3; }
.base-th-add { flex:0 0 40px; border:none; background:transparent; color:var(--text-faint,#6c7086); cursor:pointer; font-size:16px; }
.base-tbody { position:relative; }
.base-tr { position:absolute; left:0; height:32px; display:flex; border-bottom:1px solid color-mix(in srgb, var(--border,#313244) 60%, transparent); box-sizing:border-box; }
.base-tr:hover { background:var(--bg-hover,rgba(255,255,255,0.03)); }
.base-tr-loading { color:var(--text-faint,#6c7086); padding:6px 12px; width:100%; }
.base-td { flex:0 0 auto; padding:0 8px; display:flex; align-items:center; gap:4px; overflow:hidden; white-space:nowrap; border-right:1px solid color-mix(in srgb, var(--border,#313244) 50%, transparent); box-sizing:border-box; }
.base-td:focus { outline:1px solid var(--accent,#7c3aed); outline-offset:-1px; }
.base-td-check { cursor:pointer; }
.base-td-title { font-weight:500; }
.base-kind { color:var(--text-faint,#6c7086); width:14px; flex:0 0 auto; text-align:center; }
.base-title { overflow:hidden; text-overflow:ellipsis; }
.base-title-page { color:var(--text,#cdd6f4); text-decoration:none; }
.base-title-page:hover { text-decoration:underline; }
.base-row-action { border:none; background:transparent; color:var(--text-faint,#6c7086); cursor:pointer; visibility:hidden; padding:0 2px; }
.base-tr:hover .base-row-action { visibility:visible; }
.base-editor { width:100%; background:var(--bg-base,#1e1e2e); color:var(--text,#cdd6f4); border:1px solid var(--accent,#7c3aed); border-radius:3px; font:inherit; padding:2px 4px; }
.base-num { margin-left:auto; font-variant-numeric:tabular-nums; }
.base-pill { display:inline-block; padding:0 7px; border-radius:10px; background:color-mix(in srgb, var(--accent,#7c3aed) 22%, transparent); font-size:12px; line-height:18px; }
.base-pills { display:inline-flex; gap:3px; }
.base-link { color:var(--accent,#7c3aed); }
.base-check { font-size:15px; }
.base-kanban { flex:1; display:flex; gap:10px; overflow:auto; padding:10px 12px; align-items:flex-start; }
.base-lane { flex:0 0 260px; background:var(--bg-surface,#252535); border:1px solid var(--border,#313244); border-radius:8px; padding:8px; display:flex; flex-direction:column; gap:6px; max-height:100%; }
.base-lane-over { outline:2px dashed var(--accent,#7c3aed); }
.base-lane-head { display:flex; align-items:center; gap:6px; }
.base-lane-count { color:var(--text-faint,#6c7086); font-size:12px; }
.base-lane-cards { display:flex; flex-direction:column; gap:6px; overflow:auto; }
.base-card { background:var(--bg-base,#1e1e2e); border:1px solid var(--border,#313244); border-radius:6px; padding:6px 8px; cursor:grab; display:flex; flex-direction:column; gap:3px; }
.base-card-title { font-weight:500; color:var(--text,#cdd6f4); text-decoration:none; }
.base-card-field { display:flex; gap:6px; align-items:center; font-size:12px; color:var(--text-muted,#a6adc8); }
.base-card-label { color:var(--text-faint,#6c7086); }
.base-lane-add { border:none; background:transparent; color:var(--text-faint,#6c7086); cursor:pointer; text-align:left; font:inherit; font-size:12px; }
.base-footer { display:flex; gap:12px; padding:4px 12px; border-top:1px solid var(--border,#313244); font-size:11.5px; color:var(--text-faint,#6c7086); flex-shrink:0; }
.base-error { color:var(--color-danger,#f38ba8); }
.base-hint { color:var(--text-faint,#6c7086); padding:12px; }
.base-empty { display:inline-block; min-width:1px; }
`

let installed = false

export function ensureStyle(): void {
  if (installed || typeof document === 'undefined') return
  installed = true
  const style = document.createElement('style')
  style.dataset.savoire = 'plugin-base'
  style.textContent = CSS
  document.head.appendChild(style)
}
