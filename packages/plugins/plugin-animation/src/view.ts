// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Vue d'un fichier .anim : le code (texte partage, edite a plusieurs) et la
// scene, avec sa barre de lecture et les commentaires au timecode. La scene
// se recharge quand le code ne bouge plus, au meme timecode.
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { html } from '@codemirror/lang-html'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Annotation, Compartment, EditorState, Transaction, type ChangeSpec, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import type { FileContext, FileView, ISharedText, PluginAPI, TextDelta } from '@savoire/plugin-api'
import { ANIM_TEMPLATE } from './format'
import { AnimationPlayer } from './player'
import { TimecodeReview } from './review'
import { ensureStyle } from './style'
import { Transport } from './transport'

const RELOAD_MS = 700
const MIN_HEIGHT = 120
const MAX_HEIGHT = 1400

type Mode = 'split' | 'code' | 'preview'

const fromShared = Annotation.define<boolean>()

/** Texte partage <-> CodeMirror : nos frappes partent, celles des autres arrivent. */
function bindShared(text: ISharedText): { extension: Extension; attach(view: EditorView): () => void } {
  const extension = EditorView.updateListener.of(u => {
    for (const tr of u.transactions) {
      if (!tr.docChanged || tr.annotation(fromShared)) continue
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
  })
  const attach = (view: EditorView) => text.onChange((delta, origin) => {
    if (origin !== 'remote') return
    const annotations = [fromShared.of(true), Transaction.addToHistory.of(false)]
    const changes: ChangeSpec[] = []
    let pos = 0
    for (const op of delta) {
      if ('retain' in op) pos += op.retain
      else if ('delete' in op) { changes.push({ from: pos, to: pos + op.delete }); pos += op.delete }
      else changes.push({ from: pos, insert: op.insert })
    }
    try { view.dispatch({ changes, annotations }) } catch { /* hors bornes : realigne plus bas */ }
    const expected = text.toString()
    if (view.state.doc.toString() !== expected) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: expected }, annotations })
  })
  return { extension, attach }
}

async function readContent(path: string, ctx: FileContext): Promise<string> {
  const vault = ctx.vault
  if (!vault) return ''
  const id = vault.resolveDocumentId(path)
  return id ? vault.read(id) : vault.readDocumentByPath(path)
}

export function createAnimationView(path: string, ctx: FileContext, api: PluginAPI | undefined): FileView {
  ensureStyle()
  let readOnly = !!ctx.readOnly || !ctx.text
  let editor: EditorView | null = null
  let detach: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stable: ReturnType<typeof setTimeout> | null = null
  let mode: Mode = 'split'
  let source = ''
  let status: HTMLElement
  let codePane: HTMLElement
  let sidePane: HTMLElement
  let example: HTMLButtonElement
  let review: TimecodeReview | null = null
  const buttons = new Map<Mode, HTMLButtonElement>()
  const editable = new Compartment()
  const editableExt = () => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
  const docId = (ctx.vault ?? api?.vault)?.resolveDocumentId(path)

  const setStatus = (msg: string, bad = false) => {
    status.textContent = msg
    status.title = msg
    status.classList.toggle('anim-status-bad', bad)
  }

  const player = new AnimationPlayer(path, {
    onReady: () => { transport.update(); review?.refresh() },
    onTime: () => { transport.update(); review?.onTime() },
    onEnd: () => transport.update(),
    onSize: h => { player.frame.style.height = `${Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h))}px` },
    onError: msg => setStatus(`⚠ ${msg}`, true),
    onPicked: (sel, label) => review?.onPicked(sel, label),
  })
  const transport = new Transport(player, { icons: api?.icons, onMarker: () => {} })

  let first = true
  const reload = () => {
    setStatus('')
    // A l'ouverture, l'animation se joue ; ensuite elle reprend ou on en etait.
    void player.load(source, first ? { play: true } : {}).catch(err => setStatus(`⚠ ${String(err?.message ?? err)}`, true))
    first = false
  }
  const scheduleReload = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; reload() }, RELOAD_MS)
  }
  const setMode = (m: Mode) => {
    mode = m
    codePane.hidden = m === 'preview'
    sidePane.hidden = m === 'code'
    for (const [k, b] of buttons) b.classList.toggle('anim-btn-on', k === m)
  }

  return {
    mount(container: HTMLElement) {
      const btn = (label: string, m: Mode) => {
        const b = document.createElement('button')
        b.type = 'button'; b.className = 'anim-btn'; b.textContent = label; b.dataset.testid = `anim-mode-${m}`
        b.addEventListener('click', () => setMode(m))
        buttons.set(m, b)
        return b
      }
      const toolbar = document.createElement('div')
      toolbar.className = 'anim-toolbar'
      const again = document.createElement('button')
      again.type = 'button'; again.className = 'anim-btn'; again.textContent = '↻ Relancer'; again.dataset.testid = 'anim-reload'
      again.title = 'Relire le code et rejouer depuis le début'
      again.addEventListener('click', () => { void player.load(source, { play: true, at: 0 }) })
      status = document.createElement('span')
      status.className = 'anim-status'; status.dataset.testid = 'anim-status'
      const spacer = document.createElement('span')
      spacer.className = 'anim-spacer'
      // Animation vide : l'exemple s'insere a la demande, jamais tout seul
      // (le texte partage peut etre vide le temps de la synchro).
      example = document.createElement('button')
      example.type = 'button'; example.className = 'anim-btn'; example.textContent = 'Insérer l’exemple'; example.dataset.testid = 'anim-example'
      example.hidden = true
      example.addEventListener('click', () => {
        if (!editor || readOnly || editor.state.doc.length > 0) return
        editor.dispatch({ changes: { from: 0, insert: ANIM_TEMPLATE } })
      })
      toolbar.append(btn('Code', 'code'), btn('Côte à côte', 'split'), btn('Scène', 'preview'), again, example, spacer, status)

      codePane = document.createElement('div')
      codePane.className = 'anim-code'
      sidePane = document.createElement('div')
      sidePane.className = 'anim-side'
      const stage = document.createElement('div')
      stage.className = 'anim-stage'
      stage.append(player.frame)
      review = new TimecodeReview(api, docId, player, transport, readOnly)
      sidePane.append(stage, transport.el, review.el)
      const panes = document.createElement('div')
      panes.className = 'anim-panes'
      panes.append(codePane, sidePane)
      const root = document.createElement('div')
      root.className = 'anim-view'; root.dataset.testid = 'anim-view'
      root.append(toolbar, panes)
      container.replaceChildren(root)
      // Espace hors du code : lire / pause.
      sidePane.addEventListener('keydown', e => {
        if (e.key === ' ' && !(e.target as HTMLElement).closest('input, textarea, [contenteditable="true"], .cm-editor')) { e.preventDefault(); player.toggle(); transport.update() }
      })

      const text = ctx.text
      const start = (doc: string) => {
        source = doc
        const binding = text ? bindShared(text) : null
        // Revision : en mode suggestion, la frappe devient des propositions de texte.
        const suggestions = docId ? api?.review?.textSuggestions?.(docId) as Extension | undefined : undefined
        const annotations = docId ? api?.review?.inlineAnnotations?.(docId) as Extension | undefined : undefined
        editor = new EditorView({
          parent: codePane,
          state: EditorState.create({
            doc,
            extensions: [
              lineNumbers(), history(), EditorView.lineWrapping,
              html(), syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
              editable.of(editableExt()),
              ...(suggestions ? [suggestions] : []),
              ...(annotations ? [annotations] : []),
              ...(binding ? [binding.extension] : []),
              EditorView.updateListener.of(u => {
                if (!u.docChanged) return
                example.hidden = readOnly || u.state.doc.length > 0
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
        if (binding) detach = binding.attach(editor)
        reload()
      }
      setMode(mode)
      if (text) {
        start(text.toString())
        example.hidden = readOnly || text.length > 0
      } else {
        setStatus('Lecture seule : cette animation n’est pas reliée à la synchronisation du vault.')
        void readContent(path, ctx).then(start, err => setStatus(`⚠ ${String(err)}`, true))
      }
    },
    setReadOnly(ro: boolean) {
      const next = ro || !ctx.text
      if (next === readOnly) return
      readOnly = next
      editor?.dispatch({ effects: editable.reconfigure(editableExt()) })
      review?.setReadOnly(readOnly)
    },
    destroy() {
      if (timer) clearTimeout(timer)
      if (stable) clearTimeout(stable)
      detach?.()
      review?.dispose()
      editor?.destroy()
      player.dispose()
    },
  }
}
