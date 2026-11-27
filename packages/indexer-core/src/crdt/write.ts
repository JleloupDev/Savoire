// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecrire dans un vault sans editeur (ADR-033) : le pair indexeur du serveur
// execute les outils des agents. Chaque fonction rejoue le journal, applique
// la modification, et rend SEULEMENT la difference (une mise a jour Yjs), que
// le serveur enregistre comme celle d'un client.
//
// Memes structures que l'appli :
//  - texte d'une note : Y.Text « codemirror » (YjsCrdtAdapter) ;
//  - arborescence : cartes « vault » (id -> { path, kind? }) et « folders »
//    (chemin + « / » -> 1) (YMapVaultDirectory) ;
//  - canal partage (Revision) : carte « entries » (YMapIndexChannel) ;
//  - ancres : positions relatives Yjs en JSON (ReviewService.anchor).
import * as Y from 'yjs'
import { FOLDERS_MAP, VAULT_MAP } from './tree'
import { fromBase64, loadDoc, type YjsUpdate } from './yjs'

export const NOTE_TEXT = 'codemirror'
const MAX_QUOTE = 2000

/** Rejoue, modifie, rend la difference. */
function diffAfter(updates: readonly YjsUpdate[], change: (doc: Y.Doc) => void): Uint8Array {
  const doc = loadDoc(updates)
  try {
    const before = Y.encodeStateVector(doc)
    change(doc)
    return Y.encodeStateAsUpdate(doc, before)
  } finally {
    doc.destroy()
  }
}

/** Le texte d'une note, tel que son journal le donne. */
export function noteText(updates: readonly YjsUpdate[]): string {
  const doc = loadDoc(updates)
  try { return doc.getText(NOTE_TEXT).toString() } finally { doc.destroy() }
}

/** Remplace [from, to) du texte de la note par `insert`. */
export function replaceTextUpdate(updates: readonly YjsUpdate[], from: number, to: number, insert: string): Uint8Array {
  return diffAfter(updates, doc => {
    const text = doc.getText(NOTE_TEXT)
    if (from < 0 || to < from || to > text.length) throw new RangeError('plage hors du texte')
    doc.transact(() => {
      if (to > from) text.delete(from, to - from)
      if (insert) text.insert(from, insert)
    })
  })
}

/** Le contenu d'une nouvelle note. */
export function newNoteUpdate(content: string): Uint8Array {
  const doc = new Y.Doc()
  try {
    if (content) doc.getText(NOTE_TEXT).insert(0, content)
    return Y.encodeStateAsUpdate(doc)
  } finally {
    doc.destroy()
  }
}

export interface TreeEntry {
  path: string
  kind?: 'crdt' | 'snapshot'
  binary?: true
}

/** Pose (ou deplace) un document dans l'arborescence ; `folders` : dossiers explicites a ajouter. */
export function treeSetUpdate(updates: readonly YjsUpdate[], id: string, entry: TreeEntry, folders: readonly string[] = []): Uint8Array {
  return diffAfter(updates, doc => {
    doc.transact(() => {
      const map = doc.getMap<unknown>(VAULT_MAP)
      const prev = map.get(id) as TreeEntry | undefined
      map.set(id, { ...(prev ?? {}), ...entry })
      const fm = doc.getMap<unknown>(FOLDERS_MAP)
      for (const f of folders) {
        const key = f.endsWith('/') ? f : `${f}/`
        if (key !== '/' && !fm.has(key)) fm.set(key, 1)
      }
    })
  })
}

/** Pose plusieurs documents d'un coup (une archive deballee), et leurs dossiers. */
export function treeSetManyUpdate(updates: readonly YjsUpdate[], entries: readonly { id: string; entry: TreeEntry }[], folders: readonly string[] = []): Uint8Array {
  return diffAfter(updates, doc => {
    doc.transact(() => {
      const map = doc.getMap<unknown>(VAULT_MAP)
      for (const { id, entry } of entries) {
        const prev = map.get(id) as TreeEntry | undefined
        map.set(id, { ...(prev ?? {}), ...entry })
      }
      const fm = doc.getMap<unknown>(FOLDERS_MAP)
      for (const f of folders) {
        const key = f.endsWith('/') ? f : `${f}/`
        if (key !== '/' && !fm.has(key)) fm.set(key, 1)
      }
    })
  })
}

/** Ajoute des dossiers explicites (vides) a l'arborescence. */
export function treeFoldersUpdate(updates: readonly YjsUpdate[], folders: readonly string[]): Uint8Array {
  return diffAfter(updates, doc => {
    const fm = doc.getMap<unknown>(FOLDERS_MAP)
    doc.transact(() => { for (const f of folders) { const key = f.endsWith('/') ? f : `${f}/`; if (key !== '/' && !fm.has(key)) fm.set(key, 1) } })
  })
}

/** Les dossiers d'un chemin, du plus haut au plus profond (« A/B/n.md » -> « A », « A/B »). */
export function parentFolders(path: string): string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, i) => parts.slice(0, i + 1).join('/'))
}

/** Une ancre de Revision sur [from, to) du texte (meme forme que ReviewService.anchor). */
export function textAnchor(updates: readonly YjsUpdate[], from: number, to: number): { from: Record<string, unknown>; to: Record<string, unknown>; quote: string } {
  const doc = loadDoc(updates)
  try {
    const text = doc.getText(NOTE_TEXT)
    const a = Math.max(0, Math.min(from, to))
    const b = Math.min(text.length, Math.max(from, to))
    // Debut colle au caractere qui suit, fin au caractere qui precede.
    const rel = (i: number, assoc: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, i, assoc)) as Record<string, unknown>
    return { from: rel(a, 0), to: rel(b, -1), quote: text.toString().slice(a, b).slice(0, MAX_QUOTE) }
  } finally {
    doc.destroy()
  }
}

/** Ajoute (ou remplace) une entree d'un canal partage (carte « entries »). */
export function mapEntryUpdate(updates: readonly YjsUpdate[], key: string, value: unknown): Uint8Array {
  return diffAfter(updates, doc => { doc.getMap<unknown>('entries').set(key, value) })
}

/** Les entrees d'un canal partage. */
export function mapEntries(updates: readonly YjsUpdate[]): { id: string; value: unknown }[] {
  const doc = loadDoc(updates)
  try {
    const out: { id: string; value: unknown }[] = []
    doc.getMap<unknown>('entries').forEach((value, id) => out.push({ id, value }))
    return out
  } finally {
    doc.destroy()
  }
}

/**
 * Un document a modifier en place (l'arbre d'un dessin, ouvert par un outil
 * de plugin) : le Y.Doc rejoue, puis ce qui a change depuis, a envoyer.
 */
export interface DocEdit {
  readonly doc: Y.Doc
  /** Les changements faits depuis l'ouverture (ou le dernier envoi), en une mise a jour ; null : rien. */
  changes(): Uint8Array | null
  /** Les changements rendus par changes() sont partis. */
  sent(): void
}

export function editDoc(updates: readonly YjsUpdate[]): DocEdit {
  const doc = loadDoc(updates)
  let pending: Uint8Array[] = []
  doc.on('update', (u: Uint8Array) => { pending.push(u) })
  return {
    doc,
    changes: () => (pending.length ? Y.mergeUpdates(pending) : null),
    sent: () => { pending = [] },
  }
}

// ── Ancres des agents (agent-core/anchor.ts) ────────────────────────────────
//
// start et end d'une ancre : une position relative Yjs sur le texte de la
// note, encodee (Y.encodeRelativePosition) puis mise en base64.

function toBase64(u: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]!)
  return btoa(bin)
}

/** Les deux positions relatives de [from, to) dans le texte de la note, en base64 (curseur : les memes). */
export function relativeRange(doc: Y.Doc, from: number, to: number): { start: string; end: string } {
  const text = doc.getText(NOTE_TEXT)
  const a = Math.max(0, Math.min(from, to, text.length))
  const b = Math.min(text.length, Math.max(from, to))
  // Comme les ancres de la Revision : debut colle au caractere qui suit, fin a celui qui precede.
  const start = toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, a, 0)))
  return { start, end: b === a ? start : toBase64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, b, -1))) }
}

/** Ou sont ces deux positions relatives dans ce document. Null : illisibles, d'un autre texte, ou perdues. */
export function resolveRelativeIn(doc: Y.Doc, start: string, end: string): { from: number; to: number } | null {
  const text = doc.getText(NOTE_TEXT)
  const at = (b64: string): number | null => {
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(b64)), doc)
      return abs && abs.type === text ? abs.index : null
    } catch {
      return null
    }
  }
  const from = at(start)
  const to = end === start ? from : at(end)
  return from === null || to === null || to < from ? null : { from, to }
}

/** La meme chose, depuis le journal d'une note. */
export function resolveRelativeRange(updates: readonly YjsUpdate[], start: string, end: string): { from: number; to: number } | null {
  const doc = loadDoc(updates)
  try { return resolveRelativeIn(doc, start, end) } finally { doc.destroy() }
}
