// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue d'un fichier .board : le code (texte partage, edite a plusieurs) et
// l'apercu, cote a cote ou l'un ou l'autre. L'apercu se recharge quand le
// code ne bouge plus.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Annotation, Compartment, EditorState, Transaction, type ChangeSpec } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import type { FileContext, FileView, ISharedText, PluginAPI, TextDelta } from '@savoire/plugin-api'
import { confirmIn } from './confirm'
import { BoardHost } from './host'
import { ensureStyle } from './style'
import { BOARD_TEMPLATE } from './template'

const RELOAD_MS = 700

type Mode = 'split' | 'code' | 'preview'

const fromShared = Annotation.define<boolean>()

/** Texte partage <-> CodeMirror : nos frappes partent, celles des autres arrivent. */
function bind(view: EditorView, text: ISharedText): () => void {
  return text.onChange((delta: TextDelta, origin) => {
    if (origin !== 'remote') return
    const changes: ChangeSpec[] = []
    let pos = 0
    for (const op of delta) {
      if ('retain' in op) pos += op.retain
      else if ('delete' in op) { changes.push({ from: pos, to: pos + op.delete }); pos += op.delete }
      else changes.push({ from: pos, insert: op.insert })
    }
    try {
      view.dispatch({ changes, annotations: [fromShared.of(true), Transaction.addToHistory.of(false)] })
    } catch { /* hors bornes : realigne plus bas */ }
    const expected = text.toString()
    if (view.state.doc.toString() !== expected) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: expected }, annotations: [fromShared.of(true), Transaction.addToHistory.of(false)] })
    }
  })
}

async function readContent(path: string, ctx: FileContext): Promise<string> {
  const vault = ctx.vault
  if (!vault) return ''
  const id = vault.resolveDocumentId(path)
  return id ? vault.read(id) : vault.readDocumentByPath(path)
}

export function createBoardView(path: string, ctx: FileContext, api: PluginAPI | undefined): FileView {
  ensureStyle()
  let readOnly = !!ctx.readOnly || !ctx.text
  let host: BoardHost | null = null
  let editor: EditorView | null = null
  let unbind: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stable: ReturnType<typeof setTimeout> | null = null
  let mode: Mode = 'split'
  let source = ''
  let status: HTMLElement
  let preview: HTMLElement
  let codePane: HTMLElement
  let root: HTMLElement
  const buttons = new Map<Mode, HTMLButtonElement>()
  const editable = new Compartment()
  const editableExt = () => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]

  const setStatus = (msg: string, bad = false) => {
    status.textContent = msg
    status.classList.toggle('board-status-bad', bad)
  }
  const newHost = () => {
    host?.dispose()
    host = new BoardHost(api, {
      boardPath: path,
      readOnly,
      onError: msg => setStatus(`⚠ ${msg}`, true),
      confirmWrite: what => confirmIn(preview, what),
    })
    preview.replaceChildren(host.frame)
    host.load(source)
  }
  const reload = () => { setStatus(''); newHost() }
  const scheduleReload = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; reload() }, RELOAD_MS)
  }
  const setMode = (m: Mode) => {
    mode = m
    codePane.hidden = m === 'preview'
    preview.hidden = m === 'code'
    for (const [k, b] of buttons) b.classList.toggle('board-btn-on', k === m)
  }

  return {
    mount(container: HTMLElement) {
      const btn = (label: string, m: Mode) => {
        const b = document.createElement('button')
        b.type = 'button'; b.className = 'board-btn'; b.textContent = label; b.dataset.testid = `board-mode-${m}`
        b.addEventListener('click', () => setMode(m))
        buttons.set(m, b)
        return b
      }
      const toolbar = document.createElement('div')
      toolbar.className = 'board-toolbar'
      const again = document.createElement('button')
      again.type = 'button'; again.className = 'board-btn'; again.textContent = '↻ Relancer'; again.dataset.testid = 'board-reload'
      again.addEventListener('click', reload)
      status = document.createElement('span')
      status.className = 'board-status'; status.dataset.testid = 'board-status'
      const spacer = document.createElement('span')
      spacer.className = 'board-spacer'
      toolbar.append(btn('Code', 'code'), btn('Côte à côte', 'split'), btn('Aperçu', 'preview'), again, spacer, status)
      codePane = document.createElement('div')
      codePane.className = 'board-code'
      preview = document.createElement('div')
      preview.className = 'board-preview'
      const panes = document.createElement('div')
      panes.className = 'board-panes'
      panes.append(codePane, preview)
      root = document.createElement('div')
      root.className = 'board-view'; root.dataset.testid = 'board-view'
      root.append(toolbar, panes)
      container.replaceChildren(root)

      const text = ctx.text
      const start = (doc: string) => {
        source = doc
        editor = new EditorView({
          parent: codePane,
          state: EditorState.create({
            doc,
            extensions: [
              lineNumbers(), history(), EditorView.lineWrapping,
              keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
              editable.of(editableExt()),
              EditorView.updateListener.of(u => {
                if (!u.docChanged) return
                for (const tr of u.transactions) {
                  if (!tr.docChanged || tr.annotation(fromShared) || !text) continue
                  const delta: TextDelta = []
                  let pos = 0
                  tr.changes.iterChanges((fromA, toA, _fb, _tb, inserted) => {
                    if (fromA > pos) delta.push({ retain: fromA - pos })
                    if (toA > fromA) delta.push({ delete: toA - fromA })
                    if (inserted.length) delta.push({ insert: inserted.toString() })
                    pos = toA
                  })
                  text.applyDelta(delta)
                }
                source = u.state.doc.toString()
                scheduleReload()
                if (ctx.onContentStabilized) {
                  if (stable) clearTimeout(stable)
                  stable = setTimeout(() => ctx.onContentStabilized?.(source), 1000)
                }
              }),
            ],
          }),
        })
        if (text) unbind = bind(editor, text)
        newHost()
      }
      setMode(mode)
      if (text) {
        // Un board neuf commence vide : on y pose l'exemple.
        if (!readOnly && text.length === 0) text.insert(0, BOARD_TEMPLATE)
        start(text.toString())
      } else {
        setStatus('Lecture seule : ce board n\'est pas relié à la synchronisation du vault.')
        void readContent(path, ctx).then(start, err => setStatus(`⚠ ${String(err)}`, true))
      }
    },
    setReadOnly(ro: boolean) {
      const next = ro || !ctx.text
      if (next === readOnly) return
      readOnly = next
      editor?.dispatch({ effects: editable.reconfigure(editableExt()) })
      reload()
    },
    destroy() {
      if (timer) clearTimeout(timer)
      if (stable) clearTimeout(stable)
      unbind?.()
      editor?.destroy()
      host?.dispose()
      host = null
    },
  }
}
