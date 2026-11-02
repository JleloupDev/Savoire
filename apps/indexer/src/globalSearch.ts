// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Recherche globale sur plusieurs vaults d'une instance (POST /v1/search) :
// chaque vault rend sa page (triee par pertinence), on fusionne. Meme regle
// que le backend entre instances (GlobalSearchMerge.cs) :
//  - ordre : score decroissant, puis vaultId, puis id (ordinal) ;
//  - on s'arrete quand un vault a epuise sa page mais en a d'autres : on ne
//    classe pas ce qu'on n'a pas vu (une page peut etre plus courte que limit) ;
//  - curseur compose, opaque : par vault encore actif, le curseur de sa page
//    en cours et le nombre de resultats deja rendus de cette page.
import type { IndexState, SearchHit } from '@savoire/plugin-api'

export interface Part {
  /** Curseur de la page en cours du vault (null : premiere page). */
  c: string | null
  /** Resultats de cette page deja rendus. */
  s: number
}

export interface VaultPage {
  vaultId: string
  part: Part
  hits: SearchHit[]
  next?: string
}

export function encodeCursor(parts: Record<string, Part>, partial: boolean): string {
  return Buffer.from(JSON.stringify({ v: 1, p: parts, x: partial }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string): { parts: Record<string, Part>; partial: boolean } | null {
  try {
    const root = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; p?: unknown; x?: unknown }
    if (root?.v !== 1 || typeof root.p !== 'object' || root.p === null || Array.isArray(root.p)) return null
    const parts: Record<string, Part> = {}
    for (const [id, raw] of Object.entries(root.p as Record<string, unknown>)) {
      const p = raw as { c?: unknown; s?: unknown }
      if (typeof p !== 'object' || p === null) return null
      const c = p.c === null || p.c === undefined ? null : typeof p.c === 'string' ? p.c : undefined
      const s = p.s === undefined ? 0 : p.s
      if (c === undefined || typeof s !== 'number' || !Number.isInteger(s) || s < 0) return null
      parts[id] = { c, s }
    }
    return { parts, partial: root.x === true }
  } catch {
    return null
  }
}

function compare(a: SearchHit & { vaultId: string }, b: SearchHit & { vaultId: string }): number {
  if (a.score !== b.score) return b.score > a.score ? 1 : -1
  if (a.vaultId !== b.vaultId) return a.vaultId < b.vaultId ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Fusionne les pages : au plus `limit` resultats, et ce qui reste a lire par vault. */
export function mergePages(pages: readonly VaultPage[], limit: number): { hits: SearchHit[]; remaining: Record<string, Part> } {
  const pos = pages.map(p => Math.min(p.part.s, p.hits.length))
  const hits: SearchHit[] = []
  while (hits.length < limit) {
    if (pages.some((p, i) => pos[i]! >= p.hits.length && p.next !== undefined)) break
    let best = -1
    for (let i = 0; i < pages.length; i++) {
      if (pos[i]! >= pages[i]!.hits.length) continue
      if (best < 0 || compare({ ...pages[i]!.hits[pos[i]!]!, vaultId: pages[i]!.vaultId }, { ...pages[best]!.hits[pos[best]!]!, vaultId: pages[best]!.vaultId }) < 0) best = i
    }
    if (best < 0) break
    hits.push({ ...pages[best]!.hits[pos[best]!]!, vaultId: pages[best]!.vaultId })
    pos[best]!++
  }
  const remaining: Record<string, Part> = {}
  pages.forEach((p, i) => {
    if (pos[i]! < p.hits.length) remaining[p.vaultId] = { c: p.part.c, s: pos[i]! }
    else if (p.next !== undefined) remaining[p.vaultId] = { c: p.next, s: 0 }
  })
  return { hits, remaining }
}

const RANK = ['ready', 'lagging', 'building', 'unavailable'] as const

/** Etat le moins avance (le plus petit progres, le plus grand retard). */
export function worstIndex(states: readonly IndexState[]): IndexState {
  let rank = 0
  let progress: number | undefined
  let lagMs: number | undefined
  for (const s of states) {
    rank = Math.max(rank, Math.max(0, RANK.indexOf(s.status)))
    if (s.progress !== undefined) progress = progress === undefined ? s.progress : Math.min(progress, s.progress)
    if (s.lagMs !== undefined) lagMs = lagMs === undefined ? s.lagMs : Math.max(lagMs, s.lagMs)
  }
  const status = RANK[rank]!
  return {
    status,
    ...(status === 'building' && progress !== undefined ? { progress } : {}),
    ...(lagMs !== undefined && status !== 'ready' ? { lagMs } : {}),
  }
}
