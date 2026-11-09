// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Styles de la vue LaTeX et de son apercu (feuille injectee une fois).

export const PREVIEW_CSS = `
.tex-page { max-width: 46em; margin: 0 auto; padding: 32px 40px 64px; font: 16px/1.6 var(--font-editor, 'Source Serif 4', Georgia, serif); color: var(--text, #1e293b); }
.tex-page p { margin: 0 0 .8em; text-align: justify; hyphens: auto; }
.tex-titleblock { text-align: center; margin: 8px 0 28px; }
.tex-title { font-size: 1.9em; font-weight: 600; margin: 0 0 .4em; }
.tex-author, .tex-date { color: var(--text-muted, #475569); }
.tex-h { font-weight: 700; margin: 1.4em 0 .5em; line-height: 1.3; }
.tex-h0 { font-size: 1.8em; } .tex-h1 { font-size: 1.4em; } .tex-h2 { font-size: 1.2em; } .tex-h3 { font-size: 1.05em; } .tex-h4, .tex-h5 { font-size: 1em; display: inline; margin-right: .6em; }
.tex-num { margin-right: .8em; }
.tex-display { position: relative; margin: .9em 0; text-align: center; overflow-x: auto; }
.tex-display math { font-size: 1.1em; }
.tex-eqnum { position: absolute; right: 0; top: 50%; transform: translateY(-50%); }
.tex-list { margin: 0 0 .8em; padding-left: 1.8em; }
.tex-list li { margin: .2em 0; }
.tex-list dt { font-weight: 700; } .tex-list dd { margin: 0 0 .4em 1.5em; }
.tex-quote { margin: .8em 2em; font-style: italic; }
.tex-center { text-align: center; } .tex-flushright { text-align: right; }
.tex-abstract { margin: 0 3em 1.4em; font-size: .92em; } .tex-abstract-title { text-align: center; font-weight: 700; margin-bottom: .4em; }
.tex-verbatim { font: 13px/1.5 var(--font-mono, ui-monospace, monospace); background: var(--bg-elevated, #f1f5f9); padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
.tex-table { border-collapse: collapse; margin: .6em auto; } .tex-table td { border: 1px solid var(--border, #cbd5e1); padding: 3px 10px; }
.tex-figure { margin: 1em 0; text-align: center; } .tex-figure figcaption { font-size: .92em; margin: .4em 0; }
.tex-figure-file { display: inline-block; padding: 18px 28px; border: 1px dashed var(--border, #cbd5e1); color: var(--text-muted, #64748b); font: 13px var(--font-ui, sans-serif); }
.tex-theorem { margin: .8em 0; } .tex-theorem-label { font-weight: 700; } .tex-proof .tex-theorem-label { font-weight: 400; font-style: italic; }
.tex-theorem:not(.tex-proof):not(.tex-remark):not(.tex-example) > :not(.tex-theorem-label) { font-style: italic; }
.tex-qed { float: right; }
.tex-unknown { font: 12px var(--font-mono, monospace); color: var(--text-faint, #94a3b8); background: var(--bg-elevated, #f1f5f9); padding: 0 3px; border-radius: 3px; }
.tex-footrule { width: 30%; margin: 2em 0 .6em; border: none; border-top: 1px solid var(--border, #cbd5e1); }
.tex-footnotes { font-size: .85em; padding-left: 1.4em; }
.tex-fnref a { text-decoration: none; }
math merror { color: #dc2626; }
`

const VIEW_CSS = `
.tex-view { height: 100%; display: flex; flex-direction: column; min-height: 0; background: var(--bg-base, #fff); }
.tex-bar { display: flex; align-items: center; gap: 4px; padding: 5px 10px; border-bottom: 1px solid var(--border, #e2e8f0); font: 12px var(--font-ui, sans-serif); color: var(--text-muted, #64748b); flex-shrink: 0; }
.tex-bar button { font: inherit; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border, #e2e8f0); background: transparent; color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
.tex-bar button[aria-pressed="true"] { background: var(--accent-dim, rgba(13,148,136,.1)); color: var(--accent, #0d9488); border-color: transparent; }
.tex-bar .tex-spacer { flex: 1; }
.tex-bar .tex-status { color: var(--text-faint, #94a3b8); }
.tex-panes { flex: 1; display: flex; min-height: 0; }
.tex-source { flex: 1; min-width: 0; overflow: hidden; border-right: 1px solid var(--border, #e2e8f0); }
.tex-source .cm-editor { height: 100%; }
.tex-source .cm-scroller, .tex-source .cm-content, .tex-source .cm-line { font-family: var(--font-mono, ui-monospace, monospace) !important; font-size: 13px !important; line-height: 1.6 !important; }
.tex-source { position: relative; }
.tex-starter { position: absolute; top: 40px; left: 56px; right: 16px; font: 13px var(--font-ui, sans-serif); color: var(--text-muted, #64748b); }
.tex-starter button { font: inherit; padding: 4px 10px; margin-left: 4px; border-radius: 6px; border: 1px solid var(--accent, #0d9488); background: transparent; color: var(--accent, #0d9488); cursor: pointer; }
.tex-preview { flex: 1; min-width: 0; overflow: auto; background: var(--bg-surface, #fff); }
.tex-view[data-mode="source"] .tex-preview, .tex-view[data-mode="preview"] .tex-source { display: none; }
.tex-view[data-mode="source"] .tex-source { border-right: none; }
${PREVIEW_CSS}`

let injected = false
export function ensureStyle(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const el = document.createElement('style')
  el.dataset.savoire = 'plugin-latex'
  el.textContent = VIEW_CSS
  document.head.appendChild(el)
}
