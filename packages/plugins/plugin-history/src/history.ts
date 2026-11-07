// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Historique des versions d'une note, comme la recuperation de fichiers
// d'Obsidian et l'historique des pages de Notion :
//
//  - pendant qu'on ecrit, une version au plus toutes les 5 minutes, et une
//    derniere quand on quitte la note ;
//  - chaque version porte son auteur : seule la personne qui tape enregistre
//    (ce qui arrive d'un pair est enregistre chez lui) ;
//  - les versions vivent dans une carte partagee de la note : tous les
//    membres du vault les voient ;
//  - restaurer remet le texte d'une version comme une modification de plus :
//    rien ne s'efface, la restauration elle-meme devient une version.
import type { ISharedMap } from '@savoire/plugin-api'

export const HISTORY_MAP = 'history'
/** Ecart minimal entre deux versions d'une meme personne pendant qu'elle ecrit. */
export const VERSION_INTERVAL_MS = 5 * 60_000
/** Versions gardees par note ; les plus anciennes partent. */
export const MAX_VERSIONS = 100

export interface VersionAuthor { id: string; name: string }

export interface NoteVersion {
  id: string
  /** Date ISO. */
  at: string
  /** null : le texte d'avant l'historique (auteur inconnu). */
  author: VersionAuthor | null
  text: string
  /** Version restauree (sa date ISO), si c'est une restauration. */
  restoredFrom?: string
}

function isVersion(v: unknown): v is Omit<NoteVersion, 'id'> {
  const o = v as Partial<NoteVersion> | null
  return !!o && typeof o.at === 'string' && typeof o.text === 'string'
}

/** Versions d'une note, de la plus recente a la plus ancienne. */
export function listVersions(map: ISharedMap): NoteVersion[] {
  return map.getAll()
    .filter(e => isVersion(e.value))
    .map(e => ({ ...(e.value as Omit<NoteVersion, 'id'>), id: e.id }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
}

export interface RecorderDeps {
  /** Carte des versions d'une note, ou null (pas de vault). */
  openMap(docId: string): ISharedMap | null
  /** La personne qui ecrit ici. */
  me(): VersionAuthor
  now?(): number
}

interface DocState {
  /** Dernier texte vu (tape ici ou recu). */
  seen?: string
  /** Texte tape ici, pas encore enregistre. */
  pending?: string
  /** Date du dernier enregistrement d'ici. */
  savedAt: number
}

export class VersionRecorder {
  private readonly docs = new Map<string, DocState>()
  private seq = 0

  constructor(private readonly deps: RecorderDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private state(docId: string): DocState {
    let s = this.docs.get(docId)
    if (!s) { s = { savedAt: 0 }; this.docs.set(docId, s) }
    return s
  }

  /**
   * Une note s'est stabilisee (2 s sans changement). `local` : la personne a
   * tape ici depuis la derniere fois.
   */
  observe(docId: string, text: string, local: boolean): void {
    if (!docId) return
    const s = this.state(docId)
    if (!local) {
      s.seen = text
      if (s.pending !== undefined) s.pending = text
      return
    }
    const map = this.deps.openMap(docId)
    if (!map) return
    // Premiere modification d'une note sans historique : on garde d'abord
    // le texte d'avant, pour pouvoir y revenir.
    if (s.seen !== undefined && s.seen !== text && s.seen.trim() && listVersions(map).length === 0) {
      this.write(map, { at: new Date(this.now() - 1).toISOString(), author: null, text: s.seen })
    }
    s.seen = text
    s.pending = text
    if (this.now() - s.savedAt >= VERSION_INTERVAL_MS) this.flush(docId)
  }

  /** Enregistre ce qui attend : une note, ou toutes. */
  flush(docId?: string): void {
    for (const id of docId ? [docId] : [...this.docs.keys()]) {
      const s = this.docs.get(id)
      if (!s || s.pending === undefined) continue
      const map = this.deps.openMap(id)
      if (!map) continue
      const text = s.pending
      s.pending = undefined
      s.savedAt = this.now()
      if (listVersions(map)[0]?.text === text) continue
      this.write(map, { at: new Date(s.savedAt).toISOString(), author: this.deps.me(), text })
    }
  }

  /** Enregistre ce qui attend depuis plus de l'intervalle (minuterie). */
  tick(): void {
    for (const [id, s] of this.docs) {
      if (s.pending !== undefined && this.now() - s.savedAt >= VERSION_INTERVAL_MS) this.flush(id)
    }
  }

  /**
   * Remet le texte d'une version. `edit` ecrit dans la note (VaultAPI.editText).
   * Ce qui attend est enregistre avant ; la restauration devient une version.
   */
  async restore(docId: string, version: NoteVersion, edit: (docId: string, text: string) => Promise<boolean>): Promise<void> {
    this.flush(docId)
    const map = this.deps.openMap(docId)
    if (!map) throw new Error('Aucun vault ouvert')
    await edit(docId, version.text)
    const s = this.state(docId)
    s.seen = version.text
    s.savedAt = this.now()
    this.write(map, { at: new Date(s.savedAt).toISOString(), author: this.deps.me(), text: version.text, restoredFrom: version.at })
  }

  private write(map: ISharedMap, version: Omit<NoteVersion, 'id'>): void {
    const id = `${Date.parse(version.at).toString(36)}-${(this.seq++).toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    map.set(id, version)
    const all = listVersions(map)
    for (const old of all.slice(MAX_VERSIONS)) map.delete(old.id)
  }
}

// ── Comparaison ligne a ligne ────────────────────────────────────────────────

export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }

/** Au-dela, on ne cherche plus le plus long morceau commun (trop couteux). */
const MAX_CELLS = 4_000_000

/** Les lignes de `before` a `after` : gardees, ajoutees, retirees. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  // Debut et fin communs : hors du calcul.
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const head: DiffLine[] = a.slice(0, start).map(text => ({ kind: 'same', text }))
  const tail: DiffLine[] = a.slice(endA).map(text => ({ kind: 'same', text }))
  const ma = a.slice(start, endA), mb = b.slice(start, endB)
  const n = ma.length, m = mb.length
  if (n * m > MAX_CELLS) {
    return [...head, ...ma.map(text => ({ kind: 'del' as const, text })), ...mb.map(text => ({ kind: 'add' as const, text })), ...tail]
  }
  // Plus longue sous-suite commune, de la fin vers le debut.
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }
  const mid: DiffLine[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (ma[i] === mb[j]) { mid.push({ kind: 'same', text: ma[i] }); i++; j++ }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) mid.push({ kind: 'del', text: ma[i++] })
    else mid.push({ kind: 'add', text: mb[j++] })
  }
  while (i < n) mid.push({ kind: 'del', text: ma[i++] })
  while (j < m) mid.push({ kind: 'add', text: mb[j++] })
  return [...head, ...mid, ...tail]
}

/** Lignes ajoutees et retirees, pour un resume (« +3 −1 »). */
export function diffStats(before: string, after: string): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const l of diffLines(before, after)) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}
