// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue d'un document .tex : le source (CodeMirror, relie au CRDT du document)
// et son apercu, cote a cote. L'apercu suit chaque frappe, la sienne comme
// celle des autres membres.
import { EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { createIcon } from '@savoire/plugin-api'
import type { FileContext, FileView, PluginAPI } from '@savoire/plugin-api'
import { bindSharedText } from './binding'
import { latexLanguage } from './highlight'
import { renderLatex } from './render'
import { PREVIEW_CSS, ensureStyle } from './style'
import { LATEX_TEMPLATE } from './template'

type Mode = 'split' | 'source' | 'preview'
const MODES: [Mode, string, string][] = [['source', 'Source', 'code'], ['split', 'Côte à côte', 'columns-2'], ['preview', 'Aperçu', 'eye']]
const RENDER_MS = 120
const STABILIZE_MS = 1500

let lastMode: Mode = 'split'

export function createLatexView(path: string, ctx: FileContext, api: PluginAPI | null): FileView {
  let view: EditorView | null = null
  let detach: (() => void) | null = null
  let offStarter: (() => void) | null = null
  let renderTimer: ReturnType<typeof setTimeout> | null = null
  let stableTimer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false
  let readOnly = !!ctx.readOnly
  const editable = new Set<(ro: boolean) => void>()

  return {
    mount(container: HTMLElement) {
      ensureStyle()
      container.replaceChildren()
      const root = document.createElement('div')
      root.className = 'tex-view'
      root.dataset.testid = 'latex-view'
      root.dataset.mode = lastMode
      const bar = document.createElement('div')
      bar.className = 'tex-bar'
      const buttons = MODES.map(([mode, label, icon]) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.dataset.testid = `latex-mode-${mode}`
        b.append(createIcon(api?.icons, icon, { size: 13 }), label)
        b.addEventListener('click', () => setMode(mode))
        return b
      })
      const status = document.createElement('span')
      status.className = 'tex-status'
      status.dataset.testid = 'latex-status'
      const spacer = document.createElement('span')
      spacer.className = 'tex-spacer'
      const print = document.createElement('button')
      print.type = 'button'
      print.dataset.testid = 'latex-print'
      print.append(createIcon(api?.icons, 'printer', { size: 13 }), 'Imprimer / PDF')
      print.addEventListener('click', () => printPreview(preview.innerHTML, path))
      // Vrai PDF, compile par TeX Live sur le poste (moteur charge au premier clic).
      const compile = document.createElement('button')
      compile.type = 'button'
      compile.dataset.testid = 'latex-compile'
      compile.title = 'Compiler avec TeX Live (sur ce poste). La première fois, le moteur se télécharge (environ 30 Mo).'
      compile.append(createIcon(api?.icons, 'file-down', { size: 13 }), 'Compiler en PDF')
      compile.addEventListener('click', () => void (async () => {
        if (!view) return
        compile.disabled = true
        status.textContent = 'Compilation… (premier lancement : téléchargement du moteur)'
        try {
          const { compileLatex } = await import('./compile')
          const r = await compileLatex(view.state.doc.toString())
          if (!r.ok || !r.pdf) {
            status.textContent = `Erreur LaTeX : ${r.error ?? ''}`
            status.title = r.log ?? ''
            return
          }
          status.textContent = 'PDF compilé.'
          showPdf(r.pdf)
        } catch (err) {
          status.textContent = `Compilation impossible : ${err instanceof Error ? err.message : String(err)}`
        } finally {
          compile.disabled = false
        }
      })())
      bar.append(...buttons, spacer, status, compile, print)

      /** Le PDF compile, dans le volet d'apercu (lecteur du navigateur), avec un retour a l'apercu. */
      const showPdf = (bytes: Uint8Array) => {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }))
        const back = document.createElement('button')
        back.type = 'button'
        back.textContent = '← Aperçu rapide'
        back.style.cssText = 'margin:8px;font:12px var(--font-ui,sans-serif);padding:3px 10px;border-radius:6px;border:1px solid var(--border,#e2e8f0);background:transparent;cursor:pointer;color:inherit'
        const frame = document.createElement('iframe')
        frame.dataset.testid = 'latex-pdf'
        frame.src = url
        frame.style.cssText = 'width:100%;height:calc(100% - 44px);border:0'
        back.addEventListener('click', () => { URL.revokeObjectURL(url); preview.replaceChildren(page) })
        preview.replaceChildren(back, frame)
        if (lastMode === 'source') setMode('split')
      }

      const panes = document.createElement('div')
      panes.className = 'tex-panes'
      const source = document.createElement('div')
      source.className = 'tex-source'
      const preview = document.createElement('div')
      preview.className = 'tex-preview'
      const page = document.createElement('div')
      page.className = 'tex-page'
      page.dataset.testid = 'latex-preview'
      preview.appendChild(page)
      panes.append(source, preview)
      root.append(bar, panes)
      container.appendChild(root)

      function setMode(mode: Mode) {
        lastMode = mode
        root.dataset.mode = mode
        buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(MODES[i][0] === mode)))
      }
      setMode(lastMode)

      const render = (text: string) => {
        const { html, unknown } = renderLatex(text)
        page.innerHTML = html
        status.textContent = unknown.length ? `${unknown.length} commande(s) non reconnue(s)` : ''
        status.title = unknown.join(' ')
      }
      const schedule = (text: string) => {
        if (renderTimer) clearTimeout(renderTimer)
        renderTimer = setTimeout(() => render(text), RENDER_MS)
        if (ctx.onContentStabilized) {
          if (stableTimer) clearTimeout(stableTimer)
          stableTimer = setTimeout(() => ctx.onContentStabilized?.(text), STABILIZE_MS)
        }
      }

      const binding = ctx.text ? bindSharedText(ctx.text) : null
      const readOnlyFacet = EditorState.readOnly.of(readOnly || !ctx.text)
      view = new EditorView({
        parent: source,
        state: EditorState.create({
          doc: ctx.text?.toString() ?? '',
          extensions: [
            lineNumbers(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.lineWrapping,
            latexLanguage(),
            readOnlyFacet,
            EditorView.updateListener.of(u => { if (u.docChanged) schedule(u.state.doc.toString()) }),
            ...(binding ? [binding.extension] : []),
          ],
        }),
      })
      if (binding) detach = binding.attach(view)
      render(view.state.doc.toString())

      // Document vide : un type CRDT nait vide (son contenu n'existe que par
      // ses operations). On propose l'exemple, sur demande : l'inserer tout
      // seul doublerait le texte si un autre membre l'a deja ecrit.
      const starter = document.createElement('div')
      starter.className = 'tex-starter'
      starter.dataset.testid = 'latex-starter'
      const start = document.createElement('button')
      start.type = 'button'
      start.dataset.testid = 'latex-insert-template'
      start.textContent = 'Commencer avec un exemple'
      start.addEventListener('click', () => {
        if (view && view.state.doc.length === 0) view.dispatch({ changes: { from: 0, insert: LATEX_TEMPLATE } })
        view?.focus()
      })
      starter.append('Document vide. ', start)
      source.appendChild(starter)
      const updateStarter = () => { starter.hidden = !view || view.state.doc.length > 0 || readOnly || !ctx.text }
      updateStarter()
      offStarter = ctx.text?.onChange(() => updateStarter()) ?? null
      editable.add(() => updateStarter())
      editable.add(ro => view?.contentDOM.setAttribute('contenteditable', String(!ro && !!ctx.text)))

      if (!ctx.text) {
        // Sans texte partage (lecture d'un fichier hors synchro) : affichage seul.
        const vault = ctx.vault
        const id = vault?.resolveDocumentId(path)
        void (id ? vault!.read(id) : vault?.readDocumentByPath(path) ?? Promise.resolve(''))
          .then(content => {
            if (destroyed || !view) return
            view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } })
          })
          .catch(err => console.error('[plugin-latex] lecture impossible', path, err))
      }
    },

    setReadOnly(next: boolean) {
      readOnly = next
      for (const cb of editable) cb(next)
    },

    destroy() {
      destroyed = true
      if (renderTimer) clearTimeout(renderTimer)
      if (stableTimer) clearTimeout(stableTimer)
      detach?.()
      offStarter?.()
      view?.destroy()
      view = null
    },
  }
}

/** L'editeur d'une vue montee (tests, integrations). */
export function latexEditorOf(container: HTMLElement): EditorView | null {
  const dom = container.querySelector('.cm-editor')
  return dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null
}

/** Imprime l'apercu seul (et « Enregistrer en PDF » du navigateur). */
function printPreview(html: string, path: string): void {
  const frame = document.createElement('iframe')
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  if (!doc) { frame.remove(); return }
  const title = (path.split('/').pop() ?? path).replace(/\.tex$/i, '')
  doc.open()
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${title.replace(/</g, '&lt;')}</title><style>${PREVIEW_CSS}
@page { margin: 2cm; } body { margin: 0; } .tex-page { padding: 0; max-width: none; color: #000; }</style></head><body><div class="tex-page">${html}</div></body></html>`)
  doc.close()
  setTimeout(() => {
    frame.contentWindow?.focus()
    frame.contentWindow?.print()
    setTimeout(() => frame.remove(), 1000)
  }, 100)
}
