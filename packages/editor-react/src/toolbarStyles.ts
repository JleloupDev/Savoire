// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Styles de la barre d'edition, de la bulle de selection et de leurs menus.
// Une feuille injectee une fois : survol, focus et etat actif ne se font pas
// proprement en styles en ligne. Couleurs : les variables du theme de l'hote,
// avec des valeurs de repli. La bulle est sombre dans tous les themes.

const CSS = `
.sv-tb {
  display: flex; align-items: center; gap: 2px;
  padding: 5px 10px; min-height: 41px; box-sizing: border-box;
  border-bottom: 1px solid var(--border, #e2e8f0);
  background: var(--bg-surface, #fff);
  color: var(--text-muted, #64748b);
  font-family: var(--font-ui, Inter, system-ui, sans-serif);
  user-select: none; flex-shrink: 0; position: relative;
}
.sv-tb-spacer { flex: 1; min-width: 4px; }
.sv-tb-sep { flex: none; width: 1px; height: 18px; background: var(--border, #e2e8f0); margin: 0 5px; }
.sv-tb-wrap { position: relative; display: inline-flex; flex: none; }

.sv-tb-btn {
  flex: none; height: 30px; min-width: 30px; padding: 0 6px; box-sizing: border-box;
  display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  border: 0; border-radius: 6px; background: transparent; color: inherit;
  font: 500 13px var(--font-ui, Inter, system-ui, sans-serif); line-height: 1;
  cursor: pointer; position: relative; white-space: nowrap;
}
.sv-tb-btn:hover, .sv-tb-btn[aria-expanded="true"] { background: var(--bg-hover, #e2e8f0); color: var(--text, #0f172a); }
.sv-tb-btn:focus-visible { outline: 2px solid var(--accent, #0d9488); outline-offset: 1px; }
.sv-tb-btn[aria-pressed="true"] { background: var(--accent-dim, rgba(13,148,136,.10)); color: var(--accent, #0d9488); }
.sv-tb-btn:disabled { opacity: .4; cursor: default; }
.sv-tb-btn .sv-tb-chev { opacity: .55; margin-left: -1px; }
.sv-tb-btn.sv-tb-block { min-width: 112px; justify-content: space-between; padding: 0 6px 0 10px; color: var(--text, #0f172a); }
.sv-tb-btn.sv-tb-block:hover { background: var(--bg-hover, #e2e8f0); }
.sv-tb-btn.sv-tb-labelled { padding: 0 8px 0 6px; }

.sv-tb-menu {
  position: absolute; top: calc(100% + 6px); left: 0; z-index: 60;
  min-width: 220px; max-height: min(70vh, 460px); overflow-y: auto;
  padding: 5px; box-sizing: border-box;
  background: var(--bg-surface, #fff); color: var(--text, #0f172a);
  border: 1px solid var(--border, #e2e8f0); border-radius: 10px;
  box-shadow: 0 1px 2px rgba(15,23,42,.06), 0 8px 24px rgba(15,23,42,.14);
  font: 13px/1.3 var(--font-ui, Inter, system-ui, sans-serif);
  text-align: left; cursor: default;
}
.sv-tb-menu.sv-tb-menu-right { left: auto; right: 0; }
.sv-tb-menu.sv-tb-menu-up { top: auto; bottom: calc(100% + 6px); }
.sv-tb-item {
  display: flex; align-items: center; gap: 10px; width: 100%; box-sizing: border-box;
  padding: 6px 8px; border: 0; border-radius: 6px; background: transparent;
  color: inherit; font: inherit; text-align: left; cursor: pointer;
}
.sv-tb-item > svg, .sv-tb-item > .sv-tb-ico { color: var(--text-muted, #64748b); flex: none; }
.sv-tb-item:hover, .sv-tb-item:focus-visible { background: var(--bg-hover, #e2e8f0); outline: none; }
.sv-tb-item[aria-checked="true"] { background: var(--accent-dim, rgba(13,148,136,.10)); }
.sv-tb-item[aria-checked="true"] > svg { color: var(--accent, #0d9488); }
.sv-tb-item kbd { margin-left: auto; padding-left: 12px; font: 11px var(--font-ui, Inter, system-ui, sans-serif); color: var(--text-faint, #94a3b8); }
.sv-tb-item .sv-tb-h1 { font: 700 16px var(--font-editor, Georgia, serif); }
.sv-tb-item .sv-tb-h2 { font: 700 15px var(--font-editor, Georgia, serif); }
.sv-tb-item .sv-tb-h3 { font: 600 14px var(--font-editor, Georgia, serif); }
.sv-tb-title { padding: 6px 8px 4px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--text-faint, #94a3b8); }
.sv-tb-rule { height: 1px; margin: 4px 2px; background: var(--border, #e2e8f0); }
.sv-tb-palette { display: grid; grid-template-columns: repeat(7, 28px); gap: 6px; padding: 4px 6px 6px; }
.sv-tb-swatch {
  width: 28px; height: 28px; box-sizing: border-box; border-radius: 6px; cursor: pointer; padding: 0;
  display: grid; place-items: center; border: 1px solid var(--border, #e2e8f0);
  background: var(--bg-surface, #fff); color: var(--text, #0f172a);
  font: 600 13px var(--font-editor, Georgia, serif);
}
.sv-tb-swatch:hover, .sv-tb-swatch:focus-visible { outline: 2px solid var(--accent, #0d9488); outline-offset: 1px; }
.sv-tb-swatch[aria-checked="true"] { box-shadow: inset 0 0 0 2px var(--accent, #0d9488); }

/* ── Bulle de selection : sombre dans tous les themes ── */
.sv-bubble {
  position: fixed; z-index: 800; display: flex; align-items: center; gap: 1px;
  padding: 4px; border-radius: 10px; box-sizing: border-box;
  background: #1f2329; color: #a3abb8; border: 1px solid rgba(255,255,255,.09);
  box-shadow: 0 1px 2px rgba(0,0,0,.25), 0 10px 30px rgba(0,0,0,.35);
  font-family: var(--font-ui, Inter, system-ui, sans-serif);
  user-select: none;
}
.sv-bubble .sv-tb-btn { height: 28px; min-width: 28px; }
.sv-bubble .sv-tb-btn:hover, .sv-bubble .sv-tb-btn[aria-expanded="true"] { background: rgba(255,255,255,.10); color: #f1f3f6; }
.sv-bubble .sv-tb-btn[aria-pressed="true"] { background: rgba(94,234,212,.16); color: #5eead4; }
.sv-bubble .sv-tb-btn.sv-tb-block { min-width: 0; color: #f1f3f6; padding: 0 4px 0 8px; gap: 6px; }
.sv-bubble .sv-tb-btn.sv-tb-block:hover { background: rgba(255,255,255,.10); }
.sv-bubble .sv-tb-sep { background: rgba(255,255,255,.14); height: 16px; margin: 0 3px; }
@media (prefers-reduced-motion: no-preference) {
  .sv-tb-btn, .sv-tb-item { transition: background-color .12s, color .12s; }
  .sv-bubble { animation: sv-bubble-in .12s ease-out; }
  @keyframes sv-bubble-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
}
`

let injected = false
export function ensureToolbarStyles(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const style = document.createElement('style')
  style.dataset.savoire = 'editor-toolbar'
  style.textContent = CSS
  document.head.appendChild(style)
}
