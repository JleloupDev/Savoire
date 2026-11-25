// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Styles de la vue des PDF (view.ts). La couche de texte suit les variables
// que pdf.js pose lui-meme (--total-scale-factor...), ecrites ici a la main.

const CSS = `
.pdfv { height: 100%; display: flex; flex-direction: column; overflow: hidden; background: var(--bg-surface, #f1f5f9); font: 13px var(--font-ui, system-ui, sans-serif); color: var(--text, #1e293b); }
.pdfv-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 5px 10px; border-bottom: 1px solid var(--border, #e2e8f0); background: var(--bg-elevated, #fff); }
.pdfv-bar .pdfv-sep { width: 1px; align-self: stretch; background: var(--border, #e2e8f0); margin: 0 4px; }
.pdfv-btn { border: 1px solid var(--border, #e2e8f0); background: var(--bg-elevated, #fff); color: inherit; border-radius: 6px; padding: 3px 8px; font: inherit; cursor: pointer; line-height: 1.3; }
.pdfv-btn:hover:not(:disabled) { background: var(--bg-hover, #f1f5f9); }
.pdfv-btn:disabled { opacity: .45; cursor: default; }
.pdfv-btn.on { background: var(--accent-soft, #dbeafe); border-color: var(--accent, #3b82f6); }
.pdfv-pagein { width: 3.2em; text-align: right; font: inherit; padding: 2px 4px; border: 1px solid var(--border, #e2e8f0); border-radius: 5px; background: var(--bg-elevated, #fff); color: inherit; }
.pdfv-status { margin-left: auto; color: var(--text-muted, #64748b); font-size: 12px; }
.pdfv-main { flex: 1; min-height: 0; display: flex; }
.pdfv-scroll { flex: 1; min-width: 0; overflow: auto; position: relative; }
.pdfv-pages { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 16px; }
.pdfv-page { position: relative; background: #fff; box-shadow: 0 1px 3px rgba(15,23,42,.18); --scale-round-x: 1px; --scale-round-y: 1px; flex: none; }
.pdfv-page canvas { position: absolute; inset: 0; display: block; }
.pdfv-page .pdfv-num { position: absolute; top: 100%; right: 0; font-size: 11px; color: var(--text-faint, #94a3b8); padding-top: 1px; }
.pdfv-marks { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
.pdfv-mark { position: absolute; border-radius: 2px; }
.pdfv-mark.hl { mix-blend-mode: multiply; opacity: .42; }
.pdfv-mark.anchor { outline: 2px dashed var(--accent, #3b82f6); outline-offset: 1px; background: rgba(59,130,246,.07); }
.pdfv-mark.comment { border-bottom: 2px solid #f59e0b; background: rgba(245,158,11,.10); }
.pdfv-mark.zone.hl { opacity: .28; }
.pdfv-mark.flash { animation: pdfv-flash 1.6s ease-out 1; }
.pdfv-mark.focus { box-shadow: 0 0 0 2px var(--accent, #3b82f6); }
.pdfv-flag { position: absolute; transform: translateX(calc(-100% - 5px)); font-size: 11px; line-height: 1; padding: 2px 4px; border-radius: 3px; background: var(--accent, #3b82f6); color: #fff; pointer-events: auto; cursor: default; }
.pdfv-bubble { position: absolute; transform: translate(4px, -50%); font-size: 11px; }
@keyframes pdfv-flash { 0% { box-shadow: 0 0 0 4px rgba(250,204,21,.9); } 100% { box-shadow: 0 0 0 0 rgba(250,204,21,0); } }
.pdfv-zone-draft { position: absolute; border: 1.5px dashed var(--accent, #3b82f6); background: rgba(59,130,246,.08); z-index: 3; pointer-events: none; }
.pdfv-scroll.zoning .pdfv-page { cursor: crosshair; }
.pdfv-scroll.zoning .textLayer, .pdfv-scroll.zoning .pdfv-ocr { pointer-events: none; }
.pdfv-pop { position: absolute; z-index: 20; background: var(--bg-elevated, #fff); border: 1px solid var(--border, #e2e8f0); border-radius: 8px; box-shadow: 0 6px 24px rgba(15,23,42,.18); padding: 6px; display: flex; gap: 4px; align-items: center; flex-wrap: wrap; max-width: 360px; }
.pdfv-pop.card { display: block; width: 320px; max-width: 320px; padding: 8px; }
.pdfv-dot { width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid rgba(15,23,42,.18); cursor: pointer; padding: 0; }
.pdfv-dot:hover { transform: scale(1.12); }
.pdfv-pop input { font: inherit; padding: 3px 6px; border: 1px solid var(--border, #e2e8f0); border-radius: 5px; min-width: 180px; background: var(--bg-elevated, #fff); color: inherit; }
.pdfv-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 12px; color: var(--text-muted, #64748b); }
.pdfv-card-head .pdfv-what { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdfv-side { width: 280px; flex: none; border-left: 1px solid var(--border, #e2e8f0); background: var(--bg-elevated, #fff); overflow: auto; padding: 8px; }
.pdfv-side h4 { margin: 4px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #64748b); }
.pdfv-item { display: flex; gap: 8px; padding: 6px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.pdfv-item:hover { background: var(--bg-hover, #f1f5f9); }
.pdfv-item.resolved { opacity: .6; }
.pdfv-item .pdfv-sw { width: 10px; flex: none; border-radius: 3px; margin-top: 2px; height: 14px; }
.pdfv-item .pdfv-body { min-width: 0; flex: 1; }
.pdfv-item .pdfv-meta { font-size: 11px; color: var(--text-muted, #64748b); }
.pdfv-item .pdfv-q { font-size: 12.5px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.pdfv-item .pdfv-c { font-size: 12px; color: var(--text-muted, #64748b); margin-top: 2px; }
.pdfv-empty { color: var(--text-muted, #64748b); font-size: 12px; padding: 6px; }
.pdfv-msg { padding: 24px; color: var(--text-muted, #64748b); }

/* Couche de texte de pdf.js (variables posees par la bibliotheque). */
.pdfv .textLayer { position: absolute; text-align: initial; inset: 0; overflow: clip; opacity: 1; line-height: 1; transform-origin: 0 0; z-index: 2;
  --min-font-size: 1; --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size)); --min-font-size-inv: calc(1 / var(--min-font-size)); }
.pdfv .textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; user-select: text; }
.pdfv .textLayer > :not(.markedContent), .pdfv .textLayer .markedContent span:not(.markedContent) { z-index: 1; --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height)); --scale-x: 1; --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv)); }
.pdfv .textLayer .markedContent { display: contents; }
.pdfv .textLayer span[role="img"] { user-select: none; cursor: default; }
.pdfv .textLayer ::selection, .pdfv .pdfv-ocr ::selection { background: rgba(37, 99, 235, .28); color: transparent; }
.pdfv .textLayer br::selection, .pdfv .pdfv-ocr br::selection { background: transparent; }
.pdfv .textLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0; z-index: 0; cursor: default; user-select: none; }
.pdfv .textLayer.selecting .endOfContent { top: 0; }

/* Texte reconnu d'une page scannee : un mot par element, a sa place. */
.pdfv .pdfv-ocr { position: absolute; inset: 0; overflow: clip; z-index: 2; line-height: 1; }
.pdfv .pdfv-ocr span { position: absolute; color: transparent; white-space: pre; transform-origin: 0 0; font-family: sans-serif; cursor: text; user-select: text; }
`

let injected = false

export function ensurePdfViewStyle(): void {
  if (injected || typeof document === 'undefined') return
  injected = true
  const s = document.createElement('style')
  s.dataset.savoire = 'plugin-pdf'
  s.textContent = CSS
  document.head.appendChild(s)
}
