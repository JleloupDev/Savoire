// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une note rouverte reprend la ou on l'avait laissee : le curseur et le
// haut de l'ecran. Retenu sur l'appareil (localStorage), par document. Le
// texte arrive souvent apres la creation de l'editeur (synchro) : on attend
// qu'il soit la. Si on a deja bouge (lien vers un titre, recherche), on ne
// touche a rien.

import { EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

const PREFIX = 'plume:pos:'

interface Saved { anchor: number; head: number; top: number }

function read(key: string): Saved | null {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key)
    const v = raw ? JSON.parse(raw) as Saved : null
    return v && [v.anchor, v.head, v.top].every(n => Number.isInteger(n) && n >= 0) ? v : null
  } catch { return null }
}

function write(key: string, v: Saved): void {
  try { globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify(v)) } catch { /* navigation privee */ }
}

/** Le debut de la ligne en haut de l'ecran. */
function topPos(view: EditorView): number {
  const rect = view.scrollDOM.getBoundingClientRect()
  const block = view.lineBlockAtHeight(rect.top - view.documentTop + 1)
  return block.from
}

/** Retient et rend la position (curseur, defilement) de la note `docId`. */
export function notePosition(docId: string): Extension {
  return ViewPlugin.fromClass(class {
    private pending: Saved | null = read(docId)
    private moved = false
    private timer: ReturnType<typeof setTimeout> | null = null
    private readonly onScroll = () => this.schedule()

    /** La ligne en haut de l'ecran, tant que l'editeur est visible. */
    private shownTop: number | null = null
    private hidden = false
    private readonly resize: ResizeObserver | null

    constructor(private readonly view: EditorView) {
      view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
      if (view.state.doc.length > 0) queueMicrotask(() => this.restore())
      // Un onglet cache puis remontre : le navigateur remet le defilement en
      // haut. On revient a la ligne qui etait en haut.
      this.resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
        const visible = view.scrollDOM.clientHeight > 0
        if (!visible) { this.hidden = true; return }
        if (this.hidden && this.shownTop !== null && !this.pending) {
          const top = Math.min(this.shownTop, view.state.doc.length)
          this.moved = false
          this.scrollTo(top, 0)
        }
        this.hidden = false
      })
      this.resize?.observe(view.scrollDOM)
    }

    update(u: ViewUpdate) {
      // Un deplacement voulu (clic, lien, recherche) avant l'arrivee du texte : on le garde.
      if (u.transactions.some(tr => tr.selection && tr.isUserEvent('select'))) this.moved = true
      if (this.pending && u.docChanged && u.state.doc.length > 0) queueMicrotask(() => this.restore())
      if (u.selectionSet || u.docChanged) this.schedule()
    }

    restore() {
      const saved = this.pending
      if (!saved || !this.view.dom.isConnected) return
      this.pending = null
      if (this.moved) return
      const len = this.view.state.doc.length
      const clamp = (n: number) => Math.min(n, len)
      this.view.dispatch({ selection: EditorSelection.range(clamp(saved.anchor), clamp(saved.head)) })
      this.scrollTo(clamp(saved.top), 0)
    }

    /**
     * Le haut de l'ecran sur `pos`. L'editeur peut etre encore cache ou pas
     * mesure (onglet qui s'ouvre) : on attend qu'il ait une hauteur, et on
     * recommence tant que la ligne n'est pas en haut (hauteurs estimees).
     */
    scrollTo(pos: number, tries: number) {
      if (tries > 30 || this.moved || !this.view.dom.isConnected) return
      const scroller = this.view.scrollDOM
      if (scroller.clientHeight === 0) { setTimeout(() => this.scrollTo(pos, tries + 1), 50); return }
      this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) })
      setTimeout(() => {
        if (this.moved || !this.view.dom.isConnected) return
        const top = topPos(this.view)
        const line = (p: number) => this.view.state.doc.lineAt(p).number
        if (Math.abs(line(top) - line(pos)) > 1 && tries < 30) this.scrollTo(pos, tries + 1)
      }, 60)
    }

    schedule() {
      if (this.pending) return
      if (this.view.scrollDOM.clientHeight > 0) {
        try { this.shownTop = topPos(this.view) } catch { /* pas encore mesure */ }
      }
      if (this.timer) clearTimeout(this.timer)
      this.timer = setTimeout(() => this.save(), 400)
    }

    save() {
      this.timer = null
      if (this.pending) return
      const main = this.view.state.selection.main
      let top = main.head
      try { if (this.view.dom.isConnected) top = topPos(this.view) } catch { /* plus a l'ecran */ }
      write(docId, { anchor: main.anchor, head: main.head, top })
    }

    destroy() {
      this.resize?.disconnect()
      this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
      if (this.timer) { clearTimeout(this.timer); this.save() }
    }
  })
}
