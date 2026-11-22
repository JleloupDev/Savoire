// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les blocs de la note ouverte, en direct (voir plugin-api/noteBlocks.ts).
//
// Un seul point pour tout ce qui suit les blocs de l'editeur actif : ce qui a
// change depuis la derniere visite (visitMarks), les passages deja ecrits
// ailleurs (sharedPassages), les agents en veille (agents/agentWatch).
//
//  - onStable : la note vient de se stabiliser (~2 s sans frappe), avec ses
//    blocs ; `local` dit si la personne a tape dans cet editeur depuis la
//    derniere fois (sinon : un changement venu d'un pair) ;
//  - onTyping : la personne tape (pour annuler une analyse en cours) ;
//  - onSwitch : une autre note devient active (ou plus aucune).
import { splitNoteBlocks, type HookRegistry, type NoteBlock } from '@savoire/plugin-api'
import type { BlockMark, EditorController } from '@savoire/editor-core'

export interface BlocksSnapshot {
  vaultId: string
  docId: string
  path: string
  text: string
  blocks: NoteBlock[]
}

export interface LiveBlocksContext {
  editor: EditorController | null
  docId(): string | undefined
  path(): string | undefined
  vaultId(): string | undefined
}

type StableListener = (snap: BlocksSnapshot, info: { local: boolean }) => void
type SwitchListener = (snap: BlocksSnapshot | null, previous: BlocksSnapshot | null) => void

class LiveBlocks {
  private ctx: LiveBlocksContext | null = null
  private last: BlocksSnapshot | null = null
  private unsubTyping: (() => void) | null = null
  private readonly stable = new Set<StableListener>()
  private readonly switched = new Set<SwitchListener>()
  private readonly typing = new Set<() => void>()
  private hooked = false

  /** Branche le signal « note stabilisee » de l'editeur (une fois). */
  attachHooks(hooks: HookRegistry): void {
    if (this.hooked) return
    this.hooked = true
    hooks.onDocumentStabilized((docId, _path, content, _v, info) => {
      const ctx = this.ctx
      if (!ctx?.editor || docId !== ctx.docId()) return
      const snap = this.snapshotOf(content)
      if (!snap) return
      const previous = this.last
      this.last = snap
      // Le meme editeur a change de note : c'est un changement de note.
      if (previous && (previous.docId !== snap.docId || previous.vaultId !== snap.vaultId)) {
        for (const cb of [...this.switched]) cb(snap, previous)
        return
      }
      for (const cb of [...this.stable]) cb(snap, { local: info?.local ?? true })
    })
  }

  /** L'editeur de notes actif (appele a chaque changement d'editeur). */
  setEditor(ctx: LiveBlocksContext): void {
    // Le dernier etat de la note quittee (son editeur peut deja etre detruit).
    let previous = this.last
    try { previous = this.current() } catch { /* editeur detruit : le dernier etat connu */ }
    this.unsubTyping?.()
    this.unsubTyping = null
    this.ctx = ctx
    this.last = ctx.editor ? this.snapshotOf(ctx.editor.exportMarkdown()) : null
    if (ctx.editor) {
      this.unsubTyping = ctx.editor.on('documentChanged', () => { for (const cb of [...this.typing]) cb() })
    }
    if (previous?.docId === this.last?.docId && previous?.vaultId === this.last?.vaultId) return
    for (const cb of [...this.switched]) cb(this.last, previous)
  }

  /** Les blocs de la note active, a jour du texte de l'editeur. */
  current(): BlocksSnapshot | null {
    const editor = this.ctx?.editor
    if (!editor) return null
    const text = editor.exportMarkdown()
    if (this.last && this.last.text === text) return this.last
    this.last = this.snapshotOf(text)
    return this.last
  }

  /** Le passage visible a l'ecran (toute la note si l'editeur ne le dit pas). */
  visibleRange(): { from: number; to: number } {
    return this.ctx?.editor?.getVisibleRange?.() ?? { from: 0, to: Number.MAX_SAFE_INTEGER }
  }

  /** Les marques d'une source dans l'editeur actif. */
  setMarks(owner: string, marks: readonly BlockMark[]): void {
    try { this.ctx?.editor?.setBlockMarks?.(owner, marks) } catch { /* editeur deja detruit */ }
  }

  /** La selection dans l'editeur actif. */
  selection(): { from: number; to: number } | undefined {
    return this.ctx?.editor?.getSelectionRange?.()
  }

  /** Montre un passage de la note active. */
  reveal(from: number, to: number): void {
    this.ctx?.editor?.selectRange?.(from, to)
  }

  onStable(cb: StableListener): () => void { this.stable.add(cb); return () => { this.stable.delete(cb) } }
  onSwitch(cb: SwitchListener): () => void { this.switched.add(cb); return () => { this.switched.delete(cb) } }
  onTyping(cb: () => void): () => void { this.typing.add(cb); return () => { this.typing.delete(cb) } }

  private snapshotOf(text: string): BlocksSnapshot | null {
    const ctx = this.ctx
    const docId = ctx?.docId()
    const vaultId = ctx?.vaultId()
    if (!ctx || !docId || !vaultId) return null
    return { vaultId, docId, path: ctx.path() ?? '', text, blocks: splitNoteBlocks(text) }
  }
}

export const liveBlocks = new LiveBlocks()
