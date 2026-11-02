// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Nourrit l'index local d'un client qui n'a PAS les fichiers du vault
// (navigateur, pair a pair) : il ne telecharge pas 10 000 notes (ADR-027).
//
//  - les notes du vault (arborescence + metadonnees du canal partage
//    `metadata`, deja typees par le fournisseur de requetes) : chemin, titre,
//    proprietes et tags du frontmatter. Assez pour les requetes des bases ;
//  - le texte complet des notes que ce client a ouvertes ou lues (editeur,
//    rattrapage) : recherche plein texte, liens, tags du texte.
//
// Chaque note indexee garde la signature de sa source (table de l'hote) :
//  - `m:<empreinte>` : metadonnees seules ;
//  - `t:<empreinte>` : texte complet, lu quand les metadonnees avaient cette
//    empreinte.
// Au rechargement, seules les notes qui ont change sont recrites. Une note
// dont on a le texte et dont les metadonnees changent ailleurs est relue
// (readText). Illisible (null), elle repasse en metadonnees seules (ses
// proprietes restent justes, son texte reviendra a sa prochaine lecture) ;
// lecture en echec (erreur), elle est retentee a la synchro suivante. Un
// texte recu ici depuis la derniere synchro n'est pas relu : les
// metadonnees qui suivent sont celles de ce texte.
import type { PropertyValue } from '@savoire/plugin-api'
import { frontmatterAliases, frontmatterTags, makeRecord } from '../extract/note'
import type { NoteInput, NoteRecord } from '../extract/note'
import { shortHash } from './hash'
import type { ILocalIndex } from './LocalIndex'

/** Une note du vault telle que le fournisseur de requetes la voit (LocalIndexedDoc). */
export interface SharedNote {
  id: string
  path: string
  title: string
  props: Record<string, PropertyValue>
}

export interface SharedIndexFeederOptions {
  /** Relit le texte d'une note (session du vault). Null : illisible ; erreur : a retenter. */
  readText?: (id: string, path: string) => Promise<string | null>
  /** Notes par transaction. Defaut : 200. */
  batchSize?: number
  /** Au-dela de ce nombre de notes a ecrire, l'etat passe en construction. Defaut : 200. */
  buildingThreshold?: number
  onError?: (err: unknown) => void
}

const META = 'm:'
const TEXT = 't:'

export function metaSignature(note: SharedNote): string {
  return shortHash(JSON.stringify([note.path, note.title, note.props]))
}

export class SharedIndexFeeder {
  private latest: readonly SharedNote[] | null = null
  private readonly texts = new Map<string, { path: string; content: string }>()
  /** Signatures connues (lues une fois, puis tenues a jour ici). */
  private stored: Map<string, string> | null = null
  private readonly metaSigs = new Map<string, string>()
  /** Textes ecrits depuis la derniere synchro. */
  private readonly fresh = new Set<string>()
  private pumping: Promise<void> | null = null
  private disposed = false
  private firstSync = true

  constructor(private readonly index: ILocalIndex, private readonly options: SharedIndexFeederOptions = {}) {}

  /** Toutes les notes du vault, a chaque changement : seules celles qui ont change sont ecrites. */
  setNotes(notes: readonly SharedNote[]): void {
    this.latest = notes
    this.pump()
  }

  /** Le texte complet d'une note (ouverte dans un editeur, lue hors editeur). */
  noteText(id: string, path: string, content: string): void {
    this.texts.set(id, { path, content })
    this.pump()
  }

  /** Resolu quand tout ce qui a ete recu est ecrit. */
  async whenIdle(): Promise<void> {
    while (this.pumping) await this.pumping
  }

  dispose(): void {
    this.disposed = true
    this.latest = null
    this.texts.clear()
  }

  private pump(): void {
    if (this.pumping || this.disposed) return
    this.pumping = (async () => {
      try {
        while (!this.disposed && (this.latest || this.texts.size)) {
          if (this.texts.size) await this.writeTexts()
          else await this.sync(this.latest!)
        }
      } catch (err) {
        (this.options.onError ?? (e => console.warn('[index local] notes', e)))(err)
      } finally {
        this.pumping = null
      }
    })()
  }

  private async signatures(): Promise<Map<string, string>> {
    this.stored ??= await this.index.sources()
    return this.stored
  }

  private async writeTexts(): Promise<void> {
    const stored = await this.signatures()
    const batch = [...this.texts].slice(0, this.options.batchSize ?? 200)
    for (const [id] of batch) this.texts.delete(id)
    const inputs: NoteInput[] = []
    const sigs: Record<string, string> = {}
    for (const [id, t] of batch) {
      inputs.push({ id, path: t.path, content: t.content })
      sigs[id] = TEXT + (this.metaSigs.get(id) ?? '?')
    }
    await this.index.applyDocs(inputs, sigs)
    for (const [id, sig] of Object.entries(sigs)) {
      stored.set(id, sig)
      this.fresh.add(id)
    }
  }

  private async sync(notes: readonly SharedNote[]): Promise<void> {
    if (this.latest === notes) this.latest = null
    const stored = await this.signatures()
    const present = new Set<string>()
    const metaOnly: SharedNote[] = []
    const reread: SharedNote[] = []
    const adopted: Record<string, string> = {}
    for (const note of notes) {
      present.add(note.id)
      const ms = metaSignature(note)
      this.metaSigs.set(note.id, ms)
      const s = stored.get(note.id)
      if (s === META + ms || s === TEXT + ms) continue
      // Texte tout juste recu : ces metadonnees sont les siennes, pas de relecture.
      if (s?.startsWith(TEXT) && this.fresh.has(note.id)) adopted[note.id] = TEXT + ms
      else if (s?.startsWith(TEXT) && this.options.readText) reread.push(note)
      else metaOnly.push(note)
    }
    this.fresh.clear()
    // Notes disparues : signature sans note, ou note indexee sans signature
    // (ecrite par une version precedente, ou avant une coupure).
    const gone = new Set([...stored.keys()].filter(id => !present.has(id)))
    if (this.firstSync) {
      for (const id of (await this.index.paths()).keys()) if (!present.has(id)) gone.add(id)
    }
    for (const id of gone) this.metaSigs.delete(id)

    const total = metaOnly.length + reread.length
    const building = total > (this.options.buildingThreshold ?? 200)
    let done = 0
    const progress = () => { if (building) this.index.setState({ status: 'building', progress: Math.min(1, done / total) }) }
    progress()
    try {
      if (gone.size) {
        await this.index.removeDocs([...gone])
        for (const id of gone) stored.delete(id)
      }
      if (Object.keys(adopted).length) {
        await this.index.applyRecords([], adopted)
        for (const [id, sig] of Object.entries(adopted)) stored.set(id, sig)
      }
      const size = this.options.batchSize ?? 200
      for (let i = 0; i < metaOnly.length && !this.disposed; i += size) {
        const chunk = metaOnly.slice(i, i + size)
        const sigs: Record<string, string> = {}
        for (const n of chunk) sigs[n.id] = META + this.metaSigs.get(n.id)
        await this.index.applyRecords(chunk.map(metaRecord), sigs)
        for (const [id, sig] of Object.entries(sigs)) stored.set(id, sig)
        done += chunk.length
        progress()
      }
      for (const note of reread) {
        if (this.disposed) break
        await this.refresh(note, stored)
        done++
        progress()
      }
      if (this.firstSync && this.index.info.rebuildRequired && !this.disposed) await this.index.markBuilt()
      this.firstSync = false
    } finally {
      if (building) this.index.setState({ status: 'ready' })
    }
  }

  /** Une note dont on avait le texte a change ailleurs : on la relit. */
  private async refresh(note: SharedNote, stored: Map<string, string>): Promise<void> {
    let content: string | null
    try {
      content = await this.options.readText!(note.id, note.path)
    } catch {
      // Echec passager : la note garde son texte, elle sera relue ensuite.
      return
    }
    const ms = this.metaSigs.get(note.id) ?? metaSignature(note)
    if (content !== null) {
      await this.index.applyDocs([{ id: note.id, path: note.path, content }], { [note.id]: TEXT + ms })
      stored.set(note.id, TEXT + ms)
    } else {
      await this.index.applyRecords([metaRecord(note)], { [note.id]: META + ms })
      stored.set(note.id, META + ms)
    }
  }
}

/** Une note connue par ses metadonnees seules. */
export function metaRecord(note: SharedNote): NoteRecord {
  return makeRecord({
    id: note.id,
    path: note.path,
    title: note.title,
    props: note.props,
    tags: frontmatterTags(note.props),
    aliases: frontmatterAliases(note.props),
  })
}
