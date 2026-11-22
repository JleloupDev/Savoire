// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// « Modifié depuis votre dernière visite » : dans une note partagée, les
// blocs changés par d'autres depuis la dernière fois qu'on l'a ouverte ont un
// trait dans la marge.
//
// Ce poste garde, par note, les empreintes des blocs vus (liveBlocks). En
// quittant la note, tout ce qu'elle contient compte comme vu. Pendant qu'on
// la lit :
//  - un bloc qu'on modifie soi-même compte comme vu ;
//  - un bloc modifié par un pair prend le trait.
// Rien ne part sur le réseau : c'est un état de ce poste.
import { PROSE_BLOCK_KINDS, type NoteBlock } from '@savoire/plugin-api'
import type { BlockMark } from '@savoire/editor-core'
import { liveBlocks, type BlocksSnapshot } from './liveBlocks'

const OWNER = 'visit'
const PREFIX = 'savoire-visit:'
const INDEX_KEY = 'savoire-visit-index'
const ENABLED_KEY = 'savoire-visit-marks'
const MAX_NOTES = 300
const MAX_HASHES = 3000

function storage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

const keyOf = (vaultId: string, docId: string): string => `${PREFIX}${vaultId}:${docId}`

export function visitMarksEnabled(): boolean {
  return storage()?.getItem(ENABLED_KEY) !== 'off'
}

export function setVisitMarksEnabled(on: boolean): void {
  storage()?.setItem(ENABLED_KEY, on ? 'on' : 'off')
  if (on) state.reopen()
  else liveBlocks.setMarks(OWNER, [])
}

/** Les blocs qui comptent : ceux qu'on lit (pas le frontmatter, pas les traits). */
const counted = (b: NoteBlock): boolean => PROSE_BLOCK_KINDS.has(b.kind) || b.kind === 'code' || b.kind === 'math'

export function loadSeen(vaultId: string, docId: string): Set<string> | null {
  const raw = storage()?.getItem(keyOf(vaultId, docId))
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { h?: unknown }
    return Array.isArray(v.h) ? new Set(v.h.filter((x): x is string => typeof x === 'string')) : null
  } catch { return null }
}

export function saveSeen(vaultId: string, docId: string, hashes: Iterable<string>): void {
  const s = storage()
  if (!s) return
  const key = keyOf(vaultId, docId)
  const list = [...new Set(hashes)].slice(-MAX_HASHES)
  // Les notes vues le plus recemment en dernier ; au-dela de MAX_NOTES, les plus anciennes s'en vont.
  let index: string[] = []
  try { index = JSON.parse(s.getItem(INDEX_KEY) ?? '[]') as string[] } catch { index = [] }
  index = [...index.filter(k => k !== key), key]
  while (index.length > MAX_NOTES) s.removeItem(index.shift()!)
  try {
    s.setItem(key, JSON.stringify({ at: Date.now(), h: list }))
    s.setItem(INDEX_KEY, JSON.stringify(index))
  } catch { /* stockage plein : on n'en garde pas trace */ }
}

/** Les blocs changes depuis la visite : ceux dont l'empreinte n'a pas ete vue. */
export function changedBlocks(blocks: readonly NoteBlock[], seen: ReadonlySet<string>): NoteBlock[] {
  return blocks.filter(b => counted(b) && !seen.has(b.hash))
}

class VisitState {
  private seen: Set<string> | null = null
  /** La note ouverte attend son texte (editeur encore vide). */
  private waiting = false
  private started = false

  start(): void {
    if (this.started) return
    this.started = true
    liveBlocks.onSwitch((snap, previous) => {
      if (previous && previous.text) saveSeen(previous.vaultId, previous.docId, previous.blocks.filter(counted).map(b => b.hash))
      this.open(snap)
    })
    liveBlocks.onStable((snap, info) => {
      if (this.waiting) { this.open(snap); return }
      if (!this.seen) return
      const marked = new Set(changedBlocks(snap.blocks, this.seen).map(b => b.hash))
      if (info.local) {
        // Ce qu'on vient d'ecrire soi-meme est vu ; ce qu'un pair a change garde son trait.
        // Approximation : une frappe et un changement d'un pair dans la meme pause comptent comme vus.
        const before = this.previousMarked
        for (const h of marked) if (!before.has(h)) this.seen.add(h)
      }
      this.paint(snap)
    })
    window.addEventListener('beforeunload', () => this.flush())
  }

  /** Les empreintes marquees au dernier dessin. */
  private previousMarked = new Set<string>()

  /** Rouvre la note active (option rallumee). */
  reopen(): void {
    this.open(liveBlocks.current())
  }

  private open(snap: BlocksSnapshot | null): void {
    this.previousMarked = new Set()
    this.seen = null
    this.waiting = false
    if (!snap) { liveBlocks.setMarks(OWNER, []); return }
    if (!snap.text) { this.waiting = true; liveBlocks.setMarks(OWNER, []); return }
    const stored = loadSeen(snap.vaultId, snap.docId)
    if (!stored) {
      // Premiere visite sur ce poste : rien a signaler, tout est vu.
      this.seen = new Set(snap.blocks.filter(counted).map(b => b.hash))
      saveSeen(snap.vaultId, snap.docId, this.seen)
      liveBlocks.setMarks(OWNER, [])
      return
    }
    this.seen = stored
    this.paint(snap)
  }

  private paint(snap: BlocksSnapshot): void {
    if (!this.seen) return
    const changed = changedBlocks(snap.blocks, this.seen)
    this.previousMarked = new Set(changed.map(b => b.hash))
    if (!visitMarksEnabled()) { liveBlocks.setMarks(OWNER, []); return }
    const marks: BlockMark[] = changed.map(b => ({
      from: b.from, to: b.to, className: 'cm-block-changed', title: 'Modifié depuis votre dernière visite',
    }))
    liveBlocks.setMarks(OWNER, marks)
  }

  /** Tout ce qui est a l'ecran compte comme vu (commande « Marquer comme lu »). */
  markAllSeen(): void {
    const snap = liveBlocks.current()
    if (!snap || !this.seen) return
    for (const b of snap.blocks) if (counted(b)) this.seen.add(b.hash)
    saveSeen(snap.vaultId, snap.docId, this.seen)
    this.paint(snap)
  }

  flush(): void {
    const snap = liveBlocks.current()
    if (snap?.text) saveSeen(snap.vaultId, snap.docId, snap.blocks.filter(counted).map(b => b.hash))
  }
}

const state = new VisitState()

/** Branche le suivi des visites (une fois, au demarrage). */
export function startVisitMarks(): void {
  state.start()
}

export function markNoteAsSeen(): void {
  state.markAllSeen()
}
