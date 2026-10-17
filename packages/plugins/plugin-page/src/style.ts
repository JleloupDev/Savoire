// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Styles de la vue, limites a .savoire-page. Couleurs : les variables du
// theme de l'application, avec une valeur de repli.
import { PAGE_COLORS, PAGE_HIGHLIGHT_VALUES } from './highlight'

/** Surlignage : couleur du theme, ou l'une des six couleurs (fond translucide). */
const HIGHLIGHT_CSS = PAGE_COLORS
  .map(({ color }) => `.savoire-page .page-hl.page-hl-${color} { background: ${PAGE_HIGHLIGHT_VALUES[color]}; }`)
  .join('\n')

export const PAGE_CSS = `
.savoire-page {
  height: 100%; overflow-y: auto; box-sizing: border-box;
  background: var(--bg-base, #1e1e2e); color: var(--text, #cdd6f4);
  font-family: var(--font-editor, var(--font-ui, sans-serif));
  line-height: var(--line-height-editor, 1.6);
}
.savoire-page .page-header, .savoire-page .page-status, .savoire-page .page-body {
  max-width: 760px; margin: 0 auto; padding: 0 56px; box-sizing: border-box;
}
.savoire-page .page-header { padding-top: 48px; }
.savoire-page .page-title {
  margin: 0 0 12px; font-size: 2.2em; font-weight: 700; line-height: 1.2;
  color: var(--heading-color, var(--text, #cdd6f4)); word-break: break-word;
}
.savoire-page .page-status { font-size: var(--font-size-sm, 13px); color: var(--text-muted, #a6adc8); margin-bottom: 8px; }
.savoire-page .page-status[data-kind="error"] { color: var(--color-danger, #f38ba8); }
.savoire-page .page-body { position: relative; padding-bottom: 30vh; }
.savoire-page .page-prosemirror { outline: none; min-height: 200px; white-space: pre-wrap; word-wrap: break-word; }
.savoire-page .page-prosemirror > * { margin: 2px 0; }
.savoire-page .page-prosemirror p { margin: 4px 0; }
.savoire-page .page-prosemirror h1, .savoire-page .page-prosemirror h2, .savoire-page .page-prosemirror h3 {
  color: var(--heading-color, var(--text, #cdd6f4)); line-height: 1.3; margin: 1.1em 0 0.3em;
}
.savoire-page .page-prosemirror h1 { font-size: 1.75em; }
.savoire-page .page-prosemirror h2 { font-size: 1.4em; }
.savoire-page .page-prosemirror h3 { font-size: 1.2em; }
.savoire-page .page-prosemirror ul, .savoire-page .page-prosemirror ol { padding-left: 1.6em; }
.savoire-page .page-prosemirror ul[data-type="taskList"] { list-style: none; padding-left: 0.2em; }
.savoire-page .page-prosemirror ul[data-type="taskList"] li { display: flex; gap: 0.5em; align-items: flex-start; }
.savoire-page .page-prosemirror ul[data-type="taskList"] li > label { margin-top: 0.2em; user-select: none; }
.savoire-page .page-prosemirror ul[data-type="taskList"] li > div { flex: 1; }
.savoire-page .page-prosemirror ul[data-type="taskList"] li[data-checked="true"] > div { color: var(--text-muted, #a6adc8); text-decoration: line-through; }
.savoire-page .page-prosemirror input[type="checkbox"] { accent-color: var(--accent, #0d9488); }
.savoire-page .page-prosemirror blockquote {
  border-left: 3px solid var(--text, #cdd6f4); margin: 6px 0; padding: 2px 0 2px 14px;
}
.savoire-page .page-prosemirror pre {
  background: var(--bg-surface, #181825); border: 1px solid var(--border, #313244);
  border-radius: var(--radius-md, 6px); padding: 12px 14px; overflow-x: auto;
  font-family: var(--font-code, monospace); font-size: 0.9em;
}
.savoire-page .page-prosemirror code {
  font-family: var(--font-code, monospace); font-size: 0.9em; color: var(--color-code, inherit);
  background: var(--bg-surface, #181825); border-radius: 4px; padding: 1px 4px;
}
.savoire-page .page-prosemirror pre code { background: none; padding: 0; color: inherit; }
.savoire-page .page-prosemirror hr { border: none; border-top: 1px solid var(--border, #313244); margin: 14px 0; }
.savoire-page .page-prosemirror a { color: var(--accent, #0d9488); }
.savoire-page .page-prosemirror .ProseMirror-selectednode { outline: 2px solid var(--accent, #0d9488); border-radius: 4px; }
.savoire-page .page-prosemirror p.is-empty::before,
.savoire-page .page-prosemirror h1.is-empty::before,
.savoire-page .page-prosemirror h2.is-empty::before,
.savoire-page .page-prosemirror h3.is-empty::before {
  content: attr(data-placeholder); color: var(--text-faint, #6c7086); float: left; height: 0; pointer-events: none;
}
.savoire-page.is-readonly .page-prosemirror p.is-empty::before { content: none; }
.savoire-page .page-link-card {
  display: flex; align-items: center; gap: 8px; margin: 4px 0; padding: 6px 10px;
  border: 1px solid var(--border, #313244); border-radius: var(--radius-md, 6px);
  background: var(--bg-elevated, #313244); cursor: pointer; user-select: none;
}
.savoire-page .page-link-card:hover { background: var(--bg-hover, #45475a); }
.savoire-page .page-link-label { text-decoration: underline; text-decoration-color: var(--text-faint, #6c7086); text-underline-offset: 3px; }
.savoire-page .page-handle {
  position: absolute; left: 30px; width: 18px; height: 24px; display: flex; align-items: center; justify-content: center;
  font-size: 12px; letter-spacing: -2px; color: var(--text-faint, #6c7086); cursor: grab; border-radius: 4px; user-select: none;
}
.savoire-page .page-handle:hover { background: var(--bg-hover, #45475a); color: var(--text-muted, #a6adc8); }
.savoire-page .page-menu {
  position: absolute; z-index: 20; min-width: 220px; max-height: 300px; overflow-y: auto; padding: 4px;
  background: var(--bg-elevated, #313244); border: 1px solid var(--border, #45475a);
  border-radius: var(--radius-lg, 8px); box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,.35));
  font-family: var(--font-ui, sans-serif); font-size: var(--font-size-sm, 13px);
}
.savoire-page .page-menu-item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 4px; cursor: pointer; }
.savoire-page .page-menu-item.is-active, .savoire-page .page-menu-item:hover { background: var(--bg-hover, #45475a); }
.savoire-page .page-menu-icon {
  width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border, #45475a); border-radius: 4px; font-size: 11px; color: var(--text-muted, #a6adc8);
}
.savoire-page .page-menu-empty { padding: 6px 8px; color: var(--text-muted, #a6adc8); }
.savoire-page .page-menu-input {
  width: 240px; box-sizing: border-box; padding: 6px 8px; border-radius: 4px; font: inherit;
  border: 1px solid var(--accent, #0d9488); background: var(--bg-base, #1e1e2e); color: var(--text, #cdd6f4); outline: none;
}
.savoire-page .page-hl {
  background: var(--text-highlight-bg, rgba(255, 208, 0, 0.4)); color: inherit; border-radius: 2px; padding: 0 1px;
}
${HIGHLIGHT_CSS}
.savoire-page .page-toolbar {
  position: absolute; z-index: 25; display: flex; align-items: center; gap: 2px; padding: 3px 4px;
  background: var(--bg-elevated, #313244); border: 1px solid var(--border, #45475a);
  border-radius: var(--radius-lg, 8px); box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,.35));
  font-family: var(--font-ui, sans-serif); font-size: var(--font-size-sm, 13px); white-space: nowrap; user-select: none;
}
.savoire-page .page-toolbar[hidden] { display: none; }
.savoire-page .page-toolbar-group { position: relative; display: inline-flex; }
.savoire-page .page-toolbar-group + .page-toolbar-group:nth-child(2) { margin-left: 3px; padding-left: 3px; border-left: 1px solid var(--border, #45475a); }
.savoire-page .page-toolbar-button {
  min-width: 28px; height: 26px; padding: 0 7px; border: none; border-radius: 4px; background: none; cursor: pointer;
  color: var(--text-muted, #a6adc8); font: inherit; font-weight: 700;
}
.savoire-page .page-toolbar-button:hover { background: var(--bg-hover, #45475a); color: var(--text, #cdd6f4); }
.savoire-page .page-toolbar-button.is-active { color: var(--accent, #0d9488); }
.savoire-page .page-toolbar-button[data-key="italic"] { font-style: italic; }
.savoire-page .page-toolbar-button[data-key="strike"] { text-decoration: line-through; }
.savoire-page .page-toolbar-button[data-key="code"] { font-family: var(--font-code, monospace); font-weight: 400; }
.savoire-page .page-toolbar-button[data-key="block"] { font-weight: 500; }
.savoire-page .page-toolbar-menu {
  position: absolute; top: 100%; left: 0; margin-top: 6px; min-width: 180px; padding: 4px;
  display: flex; flex-direction: column; gap: 1px;
  background: var(--bg-elevated, #313244); border: 1px solid var(--border, #45475a);
  border-radius: var(--radius-md, 6px); box-shadow: var(--shadow-lg, 0 8px 24px rgba(0,0,0,.35));
}
.savoire-page .page-toolbar-menu[hidden] { display: none; }
.savoire-page .page-toolbar-item {
  display: flex; align-items: center; gap: 8px; padding: 4px 8px; border: none; border-radius: 4px;
  background: none; cursor: pointer; color: var(--text, #cdd6f4); font: inherit; text-align: left;
}
.savoire-page .page-toolbar-item:hover { background: var(--bg-hover, #45475a); }
.savoire-page .page-toolbar-item.is-active { color: var(--accent, #0d9488); }
.savoire-page .page-toolbar-item-icon { min-width: 22px; text-align: center; color: var(--text-muted, #a6adc8); }
@media (max-width: 600px) {
  .savoire-page .page-header, .savoire-page .page-status, .savoire-page .page-body { padding-left: 16px; padding-right: 16px; }
  .savoire-page .page-handle { display: none; }
}
`
