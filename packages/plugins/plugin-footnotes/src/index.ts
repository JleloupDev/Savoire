// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Module « Notes de bas de page » : [^1] dans le texte, [^1]: en fin de note.
// - l'appel s'affiche en petit numero ; survole, il montre la note ;
// - un clic sur l'appel va a la note, un clic sur le numero de la note revient ;
// - « Insérer une note de bas de page » (menu Insérer, palette) pose l'appel
//   au curseur et la definition en fin de note.

import type { PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { definitionPos, firstRefPos, footnoteText, insertFootnote, renderFootnotes } from './footnotes'

export { renderFootnotes, footnoteText, definitionPos, firstRefPos, insertFootnote, nextFootnoteLabel } from './footnotes'

/** Ce qu'il faut d'un editeur CodeMirror (le module ne depend pas de CodeMirror). */
interface NoteEditor {
  state: { doc: { toString(): string; length: number }; selection: { main: { head: number } }; readOnly?: boolean }
  dispatch(spec: unknown): void
  focus(): void
}
interface EditorViewClass {
  findFromDOM(dom: HTMLElement): NoteEditor | null
  scrollIntoView(pos: number, options?: { y?: 'nearest' | 'start' | 'end' | 'center' }): unknown
}

const STYLE = `
.plume-fn-ref { font-size: .72em; line-height: 0; vertical-align: super; padding: 0 1px; color: var(--accent, #7c3aed); cursor: pointer; font-weight: 600; }
.plume-fn-ref::before { content: '['; opacity: .6; }
.plume-fn-ref::after { content: ']'; opacity: .6; }
.plume-fn-ref:hover { text-decoration: underline; }
.plume-fn-def { font-size: .8em; vertical-align: baseline; padding: 0 4px 0 0; color: var(--accent, #7c3aed); cursor: pointer; font-weight: 600; }
.plume-fn-def::after { content: '.'; }
p:has(> .plume-fn-def:first-child) { font-size: .9em; color: var(--text-muted, inherit); margin: 0; }
.plume-fn-tooltip { position: fixed; z-index: 10050; max-width: 360px; padding: 6px 10px; border-radius: 6px;
  border: 1px solid var(--border, #3d3d5c); background: var(--bg-elevated, #252535); color: var(--text, #cdd6f4);
  font: 13px/1.45 var(--font-ui, system-ui); box-shadow: 0 6px 20px rgba(0,0,0,.25); pointer-events: none; white-space: pre-wrap; }
`

/** Le texte d'une note, sans la syntaxe Markdown la plus courante. */
function plainText(md: string): string {
  return md.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, p: string, a?: string) => a ?? p).replace(/[*_~=`]+/g, '')
}

function createFootnotesPlugin(): VaultPlugin {
  const cleanups: (() => void)[] = []
  return {
    manifest: {
      id: 'plugin-footnotes',
      scope: 'personal',
      name: 'Notes de bas de page',
      version: '1.0.0',
      description: 'Notes de bas de page [^1] : numéro en exposant, la note au survol, aller-retour d\'un clic',
      permissions: ['ui:editor'],
      defaultActive: true,
      official: true,
    },

    async onload(api: PluginAPI) {
      // Le rendu : appels et definitions, partout ou le Markdown est rendu.
      api.hooks.beforeParse(source => renderFootnotes(source))

      if (typeof document === 'undefined') return
      const style = document.createElement('style')
      style.dataset.plugin = 'plugin-footnotes'
      style.textContent = STYLE
      document.head.appendChild(style)
      cleanups.push(() => style.remove())

      // L'editeur d'un element rendu, s'il est dans un editeur.
      let EditorView: EditorViewClass | null = null
      void api.libraries?.load<{ EditorView: EditorViewClass }>('@codemirror/view').then(m => { EditorView = m.EditorView }, () => {})
      const editorOf = (el: Element): NoteEditor | null => {
        const dom = el.closest('.cm-editor') as HTMLElement | null
        return dom && EditorView ? EditorView.findFromDOM(dom) : null
      }
      const scope = (el: Element): ParentNode => el.closest('.cm-content, .vault-rendered-note, article, main') ?? document

      // ── La note au survol ──
      let tip: HTMLElement | null = null
      let timer: ReturnType<typeof setTimeout> | null = null
      const hide = () => {
        if (timer) { clearTimeout(timer); timer = null }
        tip?.remove()
        tip = null
      }
      const over = (e: MouseEvent) => {
        const ref = (e.target as Element | null)?.closest?.('.plume-fn-ref') as HTMLElement | null
        if (!ref) return
        hide()
        timer = setTimeout(() => {
          const id = ref.dataset.fn ?? ''
          const view = editorOf(ref)
          let text = view ? footnoteText(view.state.doc.toString(), id) : null
          if (text === null) {
            const def = scope(ref).querySelector(`.plume-fn-def[data-fn="${CSS.escape(id)}"]`)
            text = def?.parentElement ? (def.parentElement.textContent ?? '').replace(def.textContent ?? '', '').trim() : null
          }
          tip = document.createElement('div')
          tip.className = 'plume-fn-tooltip'
          tip.dataset.testid = 'footnote-tooltip'
          tip.textContent = text === null ? `Note [^${id}] introuvable` : plainText(text) || '(note vide)'
          document.body.appendChild(tip)
          const r = ref.getBoundingClientRect()
          const w = tip.offsetWidth
          tip.style.left = `${Math.max(8, Math.min(r.left - w / 2, window.innerWidth - w - 8))}px`
          tip.style.top = `${r.bottom + 6}px`
        }, 250)
      }
      const out = (e: MouseEvent) => {
        if ((e.target as Element | null)?.closest?.('.plume-fn-ref')) hide()
      }

      // ── Aller a la note, et revenir ──
      const down = (e: MouseEvent) => {
        if (e.button !== 0) return
        const el = (e.target as Element | null)?.closest?.('.plume-fn-ref, .plume-fn-def') as HTMLElement | null
        if (!el) return
        const toDef = el.classList.contains('plume-fn-ref')
        const id = el.dataset.fn ?? ''
        e.preventDefault()
        e.stopPropagation()
        hide()
        const view = editorOf(el)
        if (view && EditorView) {
          const doc = view.state.doc.toString()
          const pos = toDef ? definitionPos(doc, id) : firstRefPos(doc, id)
          if (pos < 0) return
          view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }), userEvent: 'select.footnote' })
          view.focus()
          return
        }
        const target = toDef
          ? scope(el).querySelector(`.plume-fn-def[data-fn="${CSS.escape(id)}"]`)
          : scope(el).querySelector(`.plume-fn-ref[data-fn="${CSS.escape(id)}"]`)
        target?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
      document.addEventListener('mouseover', over)
      document.addEventListener('mouseout', out)
      document.addEventListener('mousedown', down, true)
      cleanups.push(() => {
        hide()
        document.removeEventListener('mouseover', over)
        document.removeEventListener('mouseout', out)
        document.removeEventListener('mousedown', down, true)
      })

      // ── Inserer une note ──
      const insert = (raw: unknown) => {
        const view = raw as NoteEditor | null
        if (!view || view.state.readOnly) return
        const doc = view.state.doc.toString()
        const { changes, cursor } = insertFootnote(doc, view.state.selection.main.head)
        view.dispatch({ changes, selection: { anchor: cursor }, scrollIntoView: true, userEvent: 'input.footnote' })
        view.focus()
      }
      api.commands.register({
        id: 'footnotes:insert',
        label: 'Insérer une note de bas de page',
        editor: true,
        run: ctx => insert(ctx.editorView),
      })
      api.toolbar.register({
        id: 'footnotes-insert',
        label: 'Note de bas de page',
        icon: 'superscript',
        group: 'insert',
        menu: 'insert',
        commandId: 'footnotes:insert',
        run: ctx => insert(ctx.view),
      })
    },

    async onunload() {
      for (const c of cleanups.splice(0)) c()
    },
  }
}

const plugin: VaultPlugin = createFootnotesPlugin()
export default plugin
export { createFootnotesPlugin }
