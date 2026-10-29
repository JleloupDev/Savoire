// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecrit dans le texte d'une note hors de son editeur, comme une frappe de la
// personne : le panneau d'une base qui change une cellule (frontmatter), une
// ligne promue en page. Voir VaultAPI.editText.
//
//  - On ouvre le document par la session (ouvertures comptees : un editeur
//    deja ouvert sur la note n'est pas coupe a la fermeture).
//  - On attend que son contenu soit arrive : il arrive apres l'ouverture, en
//    changements distants (regle d'openDocument). Editer un texte encore vide
//    poserait un second frontmatter devant le vrai.
//  - On n'ecrit que la difference (un seul remplacement) : elle fusionne
//    avec ce que tapent les autres.
//  - Le document reste ouvert un court moment : plusieurs cellules de suite
//    ne rouvrent pas la note, et l'envoi a le temps de partir.
import { minimalTextChange } from '@savoire/domain-index'
import type { ICRDT, ISharedText } from '@savoire/plugin-api'
import type { IVaultSyncSession } from './contracts'

export interface NoteTextEditorOptions {
  /** Apres chaque edition : pour reindexer la note tout de suite. */
  onEdited?: (docId: string, text: string) => void
  /** Attente maximale du contenu de la note. Defaut : 8 s. */
  loadTimeoutMs?: number
  /** Duree pendant laquelle la note reste ouverte apres la derniere edition. Defaut : 3 s. */
  keepOpenMs?: number
  /**
   * Note lue vide : attente d'un contenu avant d'ecrire. Une lecture peut
   * etre en retard (cache du profil serveur) ; ecrire sur un texte vide
   * poserait un second frontmatter devant le vrai. Defaut : 1,5 s.
   */
  emptyWaitMs?: number
}

interface Held {
  session: IVaultSyncSession
  crdt: ICRDT
  users: number
  timer?: ReturnType<typeof setTimeout>
}

export class NoteTextEditor {
  private readonly held = new Map<string, Held>()

  constructor(
    private readonly getSession: () => IVaultSyncSession | undefined,
    private readonly options: NoteTextEditorOptions = {},
  ) {}

  /** Voir VaultAPI.editText. Rend false si le texte n'a pas change. */
  async edit(docId: string, edit: (current: string) => string): Promise<boolean> {
    const session = this.getSession()
    if (!session) throw new Error('Aucun vault ouvert : impossible de modifier la note.')
    // Contenu deja connu (pairs, serveur, disque) : la reference a attendre.
    const known = await session.readDocument(docId, 'crdt')
    const crdt = this.acquire(session, docId)
    try {
      const text = session.openText(docId)
      await this.waitForContent(text, known)
      const before = text.toString()
      const after = edit(before)
      const change = minimalTextChange(before, after)
      if (!change) return false
      const delta: ({ retain: number } | { delete: number } | { insert: string })[] = []
      if (change.from > 0) delta.push({ retain: change.from })
      if (change.to > change.from) delta.push({ delete: change.to - change.from })
      if (change.insert) delta.push({ insert: change.insert })
      text.applyDelta(delta)
      if (known === '') {
        // Note vide ou neuve : rien n'a prouve que sa synchro etait deja
        // branchee (un profil peut taire une op envoyee trop tot). On pousse
        // aussi son etat complet, petit ici, par le chemin qui ne perd rien.
        await session.mergeDocumentState(docId, crdt.getSnapshot())
      }
      this.options.onEdited?.(docId, text.toString())
      return true
    } finally {
      this.release(docId)
    }
  }

  /** Ferme tout ce qui est encore tenu (changement de vault). */
  dispose(): void {
    for (const [docId, h] of this.held) {
      if (h.timer) clearTimeout(h.timer)
      h.session.closeDocument(docId)
    }
    this.held.clear()
  }

  /**
   * Attend le contenu connu. Le texte arrive par morceaux (une op par
   * modification passee) : on attend qu'il soit egal au contenu lu, ou au
   * moins aussi long et calme un instant (un autre membre a pu taper entre
   * la lecture et l'ouverture).
   */
  private waitForContent(text: ISharedText, known: string): Promise<void> {
    if (known === '' && text.length === 0) return this.waitIfEmpty(text)
    if (text.toString() === known) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let quiet: ReturnType<typeof setTimeout> | undefined
      const done = (ok: boolean) => {
        clearTimeout(timer)
        if (quiet) clearTimeout(quiet)
        stop()
        if (ok) resolve()
        else reject(new Error('Le contenu de la note n\'est pas arrivé : rien n\'a été modifié.'))
      }
      const check = () => {
        if (quiet) { clearTimeout(quiet); quiet = undefined }
        if (text.toString() === known) return done(true)
        if (text.length >= known.length) quiet = setTimeout(() => done(true), 150)
      }
      const timer = setTimeout(() => done(known === '' || text.length >= known.length), this.options.loadTimeoutMs ?? 8000)
      const stop = text.onChange(check)
      check()
    })
  }

  /** Texte vide : il l'est vraiment, ou son contenu n'est pas encore la. On laisse un moment. */
  private waitIfEmpty(text: ISharedText): Promise<void> {
    return new Promise(resolve => {
      let quiet: ReturnType<typeof setTimeout> | undefined
      const done = () => { clearTimeout(timer); if (quiet) clearTimeout(quiet); stop(); resolve() }
      const timer = setTimeout(done, this.options.emptyWaitMs ?? 1500)
      const stop = text.onChange(() => {
        if (quiet) clearTimeout(quiet)
        quiet = setTimeout(done, 150)
      })
    })
  }

  private acquire(session: IVaultSyncSession, docId: string): ICRDT {
    let h = this.held.get(docId)
    if (h && h.session !== session) {
      // Vault change entre-temps : rendre l'ancienne ouverture.
      if (h.timer) clearTimeout(h.timer)
      h.session.closeDocument(docId)
      this.held.delete(docId)
      h = undefined
    }
    if (!h) {
      h = { session, crdt: session.openDocument(docId), users: 0 }
      this.held.set(docId, h)
    }
    if (h.timer) { clearTimeout(h.timer); h.timer = undefined }
    h.users++
    return h.crdt
  }

  private release(docId: string): void {
    const h = this.held.get(docId)
    if (!h) return
    h.users--
    if (h.users > 0) return
    h.timer = setTimeout(() => {
      if (this.held.get(docId) !== h) return
      this.held.delete(docId)
      h.session.closeDocument(docId)
    }, this.options.keepOpenMs ?? 3000)
  }
}
