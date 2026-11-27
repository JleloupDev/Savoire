// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue d'un fichier de code ou de donnees (.json, .geojson, .js, .mjs, .css) :
// un editeur de texte partage. C'est ainsi que les donnees d'une application
// se lisent et se corrigent aussi sans elle. Un JSON invalide est signale.
import type { FileContext, FileView } from '@savoire/plugin-api'
import { createCodeEditor, readContent, type CodeEditor } from './editor'
import { ensureAppStyle } from './style'

export function createCodeFileView(path: string, ctx: FileContext): FileView {
  ensureAppStyle()
  let editor: CodeEditor | null = null
  let status: HTMLElement
  const isJson = /\.(geo)?json$/i.test(path)
  const check = (doc: string) => {
    if (!isJson) return
    if (!doc.trim()) { status.textContent = ''; return }
    try { JSON.parse(doc); status.textContent = 'JSON valide'; status.classList.remove('board-status-bad') } catch (err) {
      status.textContent = `⚠ JSON invalide : ${err instanceof Error ? err.message : String(err)}`
      status.classList.add('board-status-bad')
    }
  }
  return {
    mount(container: HTMLElement) {
      const root = document.createElement('div')
      root.className = 'board-view app-code-view'
      root.dataset.testid = 'app-code-file'
      const toolbar = document.createElement('div')
      toolbar.className = 'board-toolbar'
      const spacer = document.createElement('span')
      spacer.className = 'board-spacer'
      status = document.createElement('span')
      status.className = 'board-status'
      status.dataset.testid = 'app-code-status'
      toolbar.append(spacer, status)
      const pane = document.createElement('div')
      pane.className = 'board-code'
      pane.style.flex = '1'
      root.append(toolbar, pane)
      container.replaceChildren(root)
      const start = (doc: string) => {
        editor = createCodeEditor({ parent: pane, doc, text: ctx.text, readOnly: !!ctx.readOnly, onChange: check })
        check(doc)
      }
      if (ctx.text) start(ctx.text.toString())
      else void readContent(path, ctx).then(start, err => { status.textContent = `⚠ ${String(err)}` })
    },
    setReadOnly(ro: boolean) {
      editor?.setReadOnly(ro || !!ctx.readOnly)
    },
    destroy() {
      editor?.destroy()
      editor = null
    },
  }
}
