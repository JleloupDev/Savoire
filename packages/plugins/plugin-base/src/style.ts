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
.base-search { width:150px; }
.base-filter-row { align-items:flex-start; flex-wrap:wrap; }
.base-filter-join { min-width:34px; color:var(--text-muted,#a6adc8); font-size:12px; padding-top:3px; }
select.base-filter-join { padding-top:2px; }
.base-filter-group { border:1px solid var(--border,#313244); border-radius:6px; padding:6px; flex:1; background:color-mix(in srgb, var(--bg-base,#1e1e2e) 60%, transparent); }
.base-filter-date { display:inline-flex; gap:4px; }
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
.base-tadd { display:block; box-sizing:border-box; min-width:100%; height:32px; padding:0 10px; border:none; border-bottom:1px solid color-mix(in srgb, var(--border,#313244) 60%, transparent); background:transparent; color:var(--text-faint,#6c7086); font:inherit; text-align:left; cursor:pointer; }
.base-tadd[hidden] { display:none; }
.base-tadd:hover { background:var(--bg-hover,rgba(127,127,127,.08)); color:var(--text-muted,#a6adc8); }
.base-tfoot { position:sticky; bottom:0; z-index:2; display:flex; background:var(--bg-base,#1e1e2e); border-top:1px solid var(--border,#313244); }
.base-tf { flex:0 0 auto; box-sizing:border-box; height:30px; padding:0 8px; border:none; background:transparent; color:transparent; font-size:12px; text-align:right; cursor:pointer; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-family:inherit; }
.base-tfoot:hover .base-tf:not(.base-tf-set):not([disabled]) { color:var(--text-faint,#6c7086); }
.base-tf-set { color:var(--text-muted,#a6adc8); font-weight:600; }
.base-tf[disabled] { cursor:default; }
.base-tr { position:absolute; left:0; height:32px; display:flex; border-bottom:1px solid color-mix(in srgb, var(--border,#313244) 60%, transparent); box-sizing:border-box; }
.base-tr:hover { background:var(--bg-hover,rgba(255,255,255,0.03)); }
.base-tr-loading { color:var(--text-faint,#6c7086); padding:6px 12px; width:100%; }
.base-td { flex:0 0 auto; padding:0 8px; display:flex; align-items:center; gap:4px; overflow:hidden; white-space:nowrap; border-right:1px solid color-mix(in srgb, var(--border,#313244) 50%, transparent); box-sizing:border-box; }
.base-td:focus { outline:1px solid var(--accent,#7c3aed); outline-offset:-1px; }
.base-td-check { cursor:pointer; }
.base-td { position:relative; }
.base-td-annotated { background:rgba(234,179,8,0.10); }
.base-td-proposed { background:rgba(34,197,94,0.10); }
.base-td-note { margin-left:auto; flex:0 0 auto; display:inline-flex; align-items:center; gap:2px; border:none; background:transparent; cursor:pointer; font-size:12px; padding:0 2px; color:var(--text-muted,#a6adc8); }
.base-td-before { text-decoration:line-through; color:var(--text-muted,#a6adc8); opacity:0.75; min-width:0; overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; }
.base-td-before * { text-decoration:line-through; }
.base-td-after { color:#15803d; font-weight:500; cursor:pointer; min-width:0; overflow:hidden; text-overflow:ellipsis; flex:0 1 auto; display:inline-flex; align-items:center; gap:4px; }
.base-td-empty { color:var(--text-faint,#6c7086); font-weight:400; }
.base-td-decision { margin-left:auto; flex:0 0 auto; display:inline-flex; gap:2px; }
.base-td-decide { border:1px solid var(--border,#313244); background:var(--bg,transparent); color:var(--text-muted,#a6adc8); border-radius:4px; cursor:pointer; font-size:11px; line-height:1; padding:2px 4px; }
.base-td-decide:hover { color:var(--red,#dc2626); border-color:currentColor; }
.base-td-accept { color:#15803d; }
.base-td-decision + .base-td-note { margin-left:0; }
.base-td-accept:hover { color:#fff; background:#16a34a; border-color:#16a34a; }
.base-td-note-count { font-size:10px; }
.base-annotation { position:absolute; z-index:35; }
.base-annotation[hidden] { display:none; }
.base-q { margin:6px 0; font-size:13px; font-family:var(--font-ui,sans-serif); color:var(--text,#cdd6f4); line-height:1.4; }
.base-q a { color:var(--text,#cdd6f4); text-decoration:none; }
.base-q a:hover { text-decoration:underline; }
.base-q-scroll { overflow-x:auto; }
.base-q-table { border-collapse:collapse; width:100%; }
.base-q-table th, .base-q-table td { border-bottom:1px solid color-mix(in srgb, var(--border,#313244) 60%, transparent); padding:5px 8px; text-align:left; white-space:nowrap; max-width:320px; overflow:hidden; text-overflow:ellipsis; }
.base-q-table td + td, .base-q-table th + th { border-left:1px solid color-mix(in srgb, var(--border,#313244) 50%, transparent); }
.base-q-table th { color:var(--text-muted,#a6adc8); font-weight:600; border-bottom-color:var(--border,#313244); }
.base-q-table td .base-num { display:block; text-align:right; }
.base-q-more { border:1px solid var(--border,#313244); background:transparent; color:var(--text-muted,#a6adc8); border-radius:4px; padding:1px 8px; font:inherit; font-size:11px; cursor:pointer; }
.base-q-more:hover { color:var(--text,#cdd6f4); }
.base-q-value { font-size:28px; font-weight:600; font-variant-numeric:tabular-nums; }
.base-q-foot { display:flex; gap:12px; font-size:11px; color:var(--text-muted,#a6adc8); margin-top:4px; }
.base-q-source { color:inherit; }
.base-q-message { color:var(--text-muted,#a6adc8); }
.base-q-bad, .base-q-error { color:var(--red,#f38ba8); }
.base-embed-board { display:flex; gap:8px; overflow-x:auto; }
.base-embed-lane { min-width:160px; background:var(--bg-surface,#181825); border-radius:6px; padding:6px; }
.base-embed-lane-head { font-size:11px; color:var(--text-muted,#a6adc8); margin-bottom:4px; }
.base-embed-card { background:var(--bg-base,#1e1e2e); border:1px solid var(--border,#313244); border-radius:4px; padding:4px 6px; margin-top:4px; }
.base-td-formula { color:var(--text-muted,#a6adc8); }
.base-td-error { color:var(--red,#f38ba8); }
.base-formula { min-width:340px; }
.base-formula-input { width:100%; box-sizing:border-box; font-family:var(--font-mono,monospace); resize:vertical; }
.base-formula-status { font-size:11px; color:var(--text-muted,#a6adc8); white-space:pre-wrap; }
.base-formula-status.base-formula-bad { color:var(--red,#f38ba8); }
.base-td-title { font-weight:500; }
.base-kind { color:var(--text-faint,#6c7086); width:14px; flex:0 0 auto; text-align:center; }
.base-title { overflow:hidden; text-overflow:ellipsis; }
.base-title-page { color:var(--text,#cdd6f4); text-decoration:none; }
.base-title-page:hover { text-decoration:underline; }
.base-title.base-td-before, .base-title.base-td-before:hover { text-decoration:line-through; color:var(--text-muted,#a6adc8); }
.base-row-action { border:none; background:transparent; color:var(--text-faint,#6c7086); cursor:pointer; visibility:hidden; padding:0 2px; }
.base-tr:hover .base-row-action { visibility:visible; }
.base-editor { width:100%; background:var(--bg-base,#1e1e2e); color:var(--text,#cdd6f4); border:1px solid var(--accent,#7c3aed); border-radius:3px; font:inherit; padding:2px 4px; }
.base-num { margin-left:auto; font-variant-numeric:tabular-nums; }
.base-pill { display:inline-block; padding:0 7px; border-radius:10px; background:color-mix(in srgb, var(--accent,#7c3aed) 22%, transparent); font-size:12px; line-height:18px; }
.base-pills { display:inline-flex; gap:3px; }
.base-color-gray { background:rgba(150,150,150,0.28); }
.base-color-brown { background:rgba(160,110,70,0.30); }
.base-color-orange { background:rgba(234,140,40,0.30); }
.base-color-yellow { background:rgba(220,180,40,0.32); }
.base-color-green { background:rgba(60,170,90,0.30); }
.base-color-blue { background:rgba(60,130,230,0.30); }
.base-color-purple { background:rgba(150,90,220,0.30); }
.base-color-pink { background:rgba(225,90,160,0.30); }
.base-color-red { background:rgba(225,70,70,0.30); }
.base-status-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; vertical-align:middle; border:1.5px solid currentColor; box-sizing:border-box; }
.base-status-doing { background:linear-gradient(90deg, currentColor 50%, transparent 50%); }
.base-status-done { background:currentColor; }
.base-person { display:inline-flex; align-items:center; gap:4px; }
.base-avatar { display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border-radius:50%; background:color-mix(in srgb, var(--accent,#7c3aed) 40%, transparent); font-size:10px; font-weight:600; }
.base-num-bar, .base-num-ring { display:inline-flex; align-items:center; gap:6px; width:100%; justify-content:flex-end; }
.base-bar { flex:1; height:6px; border-radius:3px; background:color-mix(in srgb, var(--text-faint,#6c7086) 30%, transparent); overflow:hidden; }
.base-bar-fill { display:block; height:100%; background:var(--accent,#7c3aed); }
.base-ring { width:16px; height:16px; }
.base-ring-track { stroke:color-mix(in srgb, var(--text-faint,#6c7086) 35%, transparent); }
.base-ring-fill { stroke:var(--accent,#7c3aed); }
.base-rel { text-decoration:none; padding:0 4px; border-radius:4px; background:color-mix(in srgb, var(--accent,#7c3aed) 12%, transparent); color:var(--text,#cdd6f4); }
.base-rel:hover { text-decoration:underline; }
.base-id, .base-date { color:var(--text-muted,#a6adc8); font-variant-numeric:tabular-nums; }
.base-editor-box { display:flex; align-items:center; gap:3px; width:100%; min-width:0; }
.base-editor-box .base-editor { flex:1; min-width:40px; }
.base-editor-chips { display:inline-flex; gap:3px; flex-wrap:nowrap; overflow:hidden; }
.base-pill-x { border:none; background:transparent; color:var(--text-muted,#a6adc8); cursor:pointer; padding:0 2px; font-size:12px; }
.base-file-input { display:none; }
.base-choice-menu { position:fixed; z-index:1000; max-height:280px; overflow:auto; background:var(--bg-elevated,var(--bg-surface,#252535)); border:1px solid var(--border,#313244); border-radius:8px; padding:4px; box-shadow:0 8px 24px rgba(0,0,0,0.35); font-family:var(--font-ui,sans-serif); font-size:13px; color:var(--text,#cdd6f4); }
.base-choice-item { display:flex; align-items:center; gap:6px; padding:4px 6px; border-radius:4px; cursor:pointer; }
.base-choice-active { background:var(--bg-hover,rgba(255,255,255,0.08)); }
.base-choice-group { font-size:11px; color:var(--text-faint,#6c7086); padding:6px 6px 2px; text-transform:uppercase; letter-spacing:0.04em; }
.base-choice-hint { margin-left:auto; font-size:11px; color:var(--text-faint,#6c7086); }
.base-choice-empty { padding:6px; color:var(--text-faint,#6c7086); }
.base-choice-check { width:14px; }
.base-settings { min-width:360px; }
.base-setting-label { width:130px; flex:0 0 auto; color:var(--text-muted,#a6adc8); }
.base-color-select { width:90px; }
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
.base-grouped, .base-swimlanes { flex:1; overflow:auto; padding:4px 0 12px; }
.base-group { margin-bottom:10px; }
.base-group-head { display:flex; align-items:center; gap:6px; padding:6px 12px 4px; position:sticky; left:0; }
.base-group-toggle { border:none; background:transparent; color:var(--text-muted,#a6adc8); cursor:pointer; font-size:12px; width:18px; transition:transform .12s; }
.base-group-collapsed .base-group-toggle { transform:rotate(-90deg); }
.base-group-label { font-weight:600; }
.base-table-embedded { overflow:visible; flex:none; }
.base-table-embedded .base-thead { position:static; }
.base-tmore { color:var(--text-muted,#a6adc8); }
.base-swimlane { margin-bottom:8px; }
.base-swimlane .base-kanban { padding-top:4px; }
.base-layouts { display:inline-flex; gap:2px; margin-right:6px; }
.base-layouts .base-btn { padding:2px 6px; }
.base-list { flex:1; overflow:auto; padding:6px 0; }
.base-list-item { display:flex; align-items:center; gap:8px; padding:5px 14px; border-bottom:1px solid color-mix(in srgb, var(--border,#313244) 50%, transparent); min-height:30px; }
.base-list-item:hover { background:var(--bg-hover,rgba(255,255,255,0.03)); }
.base-list-title { color:var(--text,#cdd6f4); text-decoration:none; font-weight:500; white-space:nowrap; }
.base-list-title:hover { text-decoration:underline; }
.base-list-fields { display:flex; gap:10px; margin-left:auto; color:var(--text-muted,#a6adc8); font-size:12px; overflow:hidden; white-space:nowrap; }
.base-field { display:inline-flex; align-items:center; gap:4px; }
.base-gallery .base-list-items { display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:12px; padding:10px 14px; }
.base-gallery-small .base-list-items { grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); }
.base-gallery-large .base-list-items { grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); }
.base-gallery-card { background:var(--bg-surface,#252535); border:1px solid var(--border,#313244); border-radius:8px; overflow:hidden; cursor:pointer; display:flex; flex-direction:column; }
.base-gallery-card:hover { border-color:color-mix(in srgb, var(--accent,#7c3aed) 50%, var(--border,#313244)); }
.base-gallery-body { padding:8px 10px; display:flex; flex-direction:column; gap:4px; }
.base-card-cover { height:120px; background:color-mix(in srgb, var(--text-faint,#6c7086) 15%, transparent); overflow:hidden; }
.base-card .base-card-cover { height:90px; margin:-6px -8px 4px; border-radius:6px 6px 0 0; }
.base-card-cover[hidden] { display:none; }
.base-cover-img { width:100%; height:100%; object-fit:cover; display:block; }
.base-cal { flex:1; display:flex; flex-direction:column; overflow:auto; padding:8px 12px; }
.base-cal-head { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
.base-cal-title { font-weight:600; min-width:140px; text-align:center; text-transform:capitalize; }
.base-cal-grid { display:grid; grid-template-columns:repeat(7, minmax(0, 1fr)); border-left:1px solid var(--border,#313244); border-top:1px solid var(--border,#313244); }
.base-cal-weekday { padding:4px 6px; font-size:11px; color:var(--text-faint,#6c7086); border-right:1px solid var(--border,#313244); border-bottom:1px solid var(--border,#313244); }
.base-cal-day { position:relative; min-height:92px; padding:3px 4px; border-right:1px solid var(--border,#313244); border-bottom:1px solid var(--border,#313244); display:flex; flex-direction:column; gap:2px; overflow:hidden; }
.base-cal-out { background:color-mix(in srgb, var(--text-faint,#6c7086) 7%, transparent); color:var(--text-faint,#6c7086); }
.base-cal-today .base-cal-num { background:var(--accent,#7c3aed); color:#fff; border-radius:10px; padding:0 6px; }
.base-cal-num { font-size:11px; align-self:flex-end; }
.base-cal-chip { font-size:12px; background:color-mix(in srgb, var(--accent,#7c3aed) 22%, transparent); border-radius:4px; padding:1px 5px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.base-cal-add { position:absolute; top:2px; left:4px; border:none; background:transparent; color:var(--text-faint,#6c7086); cursor:pointer; visibility:hidden; }
.base-cal-day:hover .base-cal-add { visibility:visible; }
.base-cal-over { outline:2px dashed var(--accent,#7c3aed); outline-offset:-2px; }
.base-cal-note { grid-column:1 / -1; }
.base-tl { flex:1; display:flex; flex-direction:column; overflow:hidden; padding:8px 12px; }
.base-tl-body { flex:1; display:flex; overflow:hidden; border:1px solid var(--border,#313244); border-radius:6px; }
.base-tl-names { flex:0 0 200px; overflow:hidden; border-right:1px solid var(--border,#313244); }
.base-tl-name { height:30px; display:flex; align-items:center; padding:0 8px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-bottom:1px solid color-mix(in srgb, var(--border,#313244) 40%, transparent); box-sizing:border-box; }
.base-tl-name a { color:var(--text,#cdd6f4); text-decoration:none; }
.base-tl-name-head { height:26px; }
.base-tl-scroll { flex:1; overflow:auto; }
.base-tl-canvas { position:relative; }
.base-tl-ticks { position:relative; height:26px; border-bottom:1px solid var(--border,#313244); }
.base-tl-month { position:absolute; top:0; font-size:10px; color:var(--text-muted,#a6adc8); white-space:nowrap; padding-left:3px; border-left:1px solid var(--border,#313244); height:12px; line-height:12px; }
.base-tl-ticks-day .base-tl-tick { top:12px; height:14px; }
.base-tl-tick { position:absolute; top:0; height:26px; font-size:11px; color:var(--text-faint,#6c7086); display:flex; align-items:center; justify-content:center; white-space:nowrap; }
.base-tl-monday { color:var(--text-muted,#a6adc8); font-weight:600; }
.base-tl-now { color:var(--accent,#7c3aed); }
.base-tl-lanes { position:relative; }
.base-tl-today-line { position:absolute; top:0; bottom:0; width:1px; background:var(--accent,#7c3aed); opacity:.6; }
.base-tl-bar { position:absolute; height:22px; border-radius:5px; background:color-mix(in srgb, var(--accent,#7c3aed) 45%, transparent); color:var(--text,#cdd6f4); font-size:12px; padding:0 8px; display:flex; align-items:center; white-space:nowrap; overflow:hidden; cursor:grab; box-sizing:border-box; }
.base-tl-grip { position:absolute; right:0; top:0; bottom:0; width:6px; cursor:ew-resize; }
.base-tl-deps { position:absolute; left:0; top:0; pointer-events:none; overflow:visible; }
.base-tl-dep { stroke:var(--text-muted,#a6adc8); stroke-width:1.3; fill:none; }
.base-chart { flex:1; overflow:auto; padding:12px 16px; display:flex; flex-direction:column; gap:10px; }
.base-chart-drawing { width:100%; max-width:760px; height:auto; }
.base-chart-label, .base-chart-value { fill:var(--text-muted,#a6adc8); font-size:11px; font-family:var(--font-ui,sans-serif); }
.base-chart-total { fill:var(--text,#cdd6f4); font-size:22px; font-weight:600; font-family:var(--font-ui,sans-serif); }
.base-chart-axis { stroke:var(--border,#313244); }
.base-chart-line { stroke:var(--accent,#7c3aed); stroke-width:2; }
.base-chart-legend { display:flex; flex-wrap:wrap; gap:10px; font-size:12px; color:var(--text-muted,#a6adc8); }
.base-chart-item { display:inline-flex; align-items:center; gap:5px; }
.base-chart-swatch { width:10px; height:10px; border-radius:2px; display:inline-block; }
.base-form { flex:1; overflow:auto; padding:16px; display:flex; justify-content:center; }
.base-form-box { width:100%; max-width:560px; display:flex; flex-direction:column; gap:12px; }
.base-form-title { margin:0 0 4px; font-size:20px; }
.base-form-field { display:flex; flex-direction:column; gap:4px; }
.base-form-label { font-size:12px; color:var(--text-muted,#a6adc8); font-weight:600; }
.base-form-field .base-input { font-size:13px; padding:5px 8px; }
.base-form-choices { display:flex; flex-wrap:wrap; gap:8px; }
.base-form-submit { align-self:flex-start; padding:5px 16px; font-size:13px; }
.base-form-status { font-size:12px; color:var(--text-muted,#a6adc8); }
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
