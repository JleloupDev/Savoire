// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les modifications de l'IA dans une note, chacune annulable seule.
//
// Chaque ecriture d'un agent devient un POINT, range dans la note elle-meme
// (une carte Yjs `aiChanges` du Y.Doc de la note, a cote du texte) : il part
// dans la meme mise a jour que le texte, et ne se voit qu'avec la note.
//
// Un point ne copie pas la note. Il garde les operations :
//  - texte ajoute : les identifiants Yjs de ses caracteres (client, horloge,
//    longueur). Annuler supprime ceux qui sont encore la, et seulement eux :
//    ce que quelqu'un a tape au milieu depuis reste ;
//  - texte supprime : ce texte, et une position relative Yjs de l'endroit.
//    Annuler le remet la, meme si la note a bouge autour.
//
// Compactage : apres quelques minutes, les points d'un meme agent tombes dans
// la meme tranche de temps se fondent en un seul. Il garde qui (l'agent, pour
// qui) et pourquoi (les raisons des outils). L'affichage compacte de lui-meme
// (displayAiChanges) ; l'hote qui ecrit compacte aussi ce qui est range
// (recordAiChange), car il a le droit d'ecrire dans la note.
//
// Ici : Yjs seul, sans l'appli. Le pair indexeur (ecritures des IA externes)
// et l'appli (YjsCrdtAdapter) s'en servent.
import * as Y from 'yjs'
import type { AiChangeInfo, AiChangeRanges, AiChangeWho } from '@savoire/plugin-api'
import { base64ToBytes, bytesToBase64 } from './base64'

// Meme contournement que YjsCollaborativeText : les types de Yjs ne passent pas.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>

/** La carte des points, dans le Y.Doc de la note. */
export const AI_CHANGES_MAP = 'aiChanges'
/** Tranche de temps : les points d'un agent dans la meme tranche se fondent. */
export const AI_CHANGE_BUCKET_MS = 5 * 60_000
/** Une tranche se compacte un peu apres sa fin : les retardataires sont arrives. */
export const AI_CHANGE_SETTLE_MS = 60_000
/** Points gardes par note ; les plus anciens partent. */
export const MAX_AI_CHANGES = 200
/** Texte garde par operation (un tres long texte supprime n'est pas copie en entier). */
const MAX_DELETED_TEXT = 200_000

/** [client, horloge du premier caractere, nombre de caracteres]. */
export type IdRun = [number, number, number]

export type AiChangeOp =
  | { kind: 'insert'; text: string; ids: IdRun[] }
  | { kind: 'delete'; text: string; at: string }

/** Un point, tel que range dans la carte. */
export interface StoredAiChange {
  at: string
  /** Point compacte : sa derniere ecriture. */
  last?: string
  agent: { id: string; name: string; color?: string }
  forUser?: AiChangeWho
  /** Ce que l'agent a fait, une entree par ecriture (« passage remplacé »). */
  summaries: string[]
  /** Pourquoi (le champ `why` des outils), sans doublon. */
  reasons: string[]
  ops: AiChangeOp[]
  /** Ecritures fondues dans ce point (1 : pas compacte). */
  count: number
  undone?: { at: string; by: AiChangeWho }
}

export interface AiChangeMeta {
  agent: { id: string; name: string; color?: string }
  forUser?: AiChangeWho
  summary?: string
  reason?: string
}

// Les types de Yjs ne passent pas la resolution de modules (voir plus haut) :
// ce que ce module en utilise, decrit ici.
interface YText {
  toString(): string
  insert(index: number, text: string): void
  delete(index: number, length: number): void
  observe(f: (event: never) => void): void
  unobserve(f: (event: never) => void): void
}
interface YMap {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
  forEach(f: (value: unknown, key: string) => void): void
  observe(f: (event: never) => void): void
  unobserve(f: (event: never) => void): void
}
interface YDoc {
  getMap(name: string): YMap
  transact(fn: () => void, origin?: unknown): void
}

// ── Identifiants des caracteres ──────────────────────────────────────────────

interface ItemLike {
  id: { client: number; clock: number }
  length: number
  deleted: boolean
  countable: boolean
  right: ItemLike | null
}

function firstItem(text: YText): ItemLike | null {
  return (text as unknown as { _start: ItemLike | null })._start
}

/** Les identifiants des caracteres [from, from + length) du texte d'aujourd'hui. */
export function idRunsAt(text: YText, from: number, length: number): IdRun[] {
  const runs: IdRun[] = []
  let index = 0
  for (let item = firstItem(text); item && length > 0; item = item.right) {
    if (item.deleted || !item.countable) continue
    const end = index + item.length
    if (end > from) {
      const off = from - index
      const n = Math.min(item.length - off, length)
      const last = runs[runs.length - 1]
      const clock = item.id.clock + off
      if (last && last[0] === item.id.client && last[1] + last[2] === clock) last[2] += n
      else runs.push([item.id.client, clock, n])
      from += n
      length -= n
    }
    index = end
  }
  return runs
}

/** Ou sont aujourd'hui les caracteres de ces identifiants encore presents (plages croissantes, fusionnees). */
export function presentRanges(text: YText, runs: readonly IdRun[]): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  if (!runs.length) return out
  const byClient = new Map<number, IdRun[]>()
  for (const r of runs) {
    const list = byClient.get(r[0]) ?? []
    list.push(r)
    byClient.set(r[0], list)
  }
  let index = 0
  for (let item = firstItem(text); item; item = item.right) {
    if (item.deleted || !item.countable) continue
    const mine = byClient.get(item.id.client)
    if (mine) {
      const a = item.id.clock
      const b = a + item.length
      for (const [, c, n] of mine) {
        const from = Math.max(a, c)
        const to = Math.min(b, c + n)
        if (from >= to) continue
        out.push({ from: index + from - a, to: index + to - a })
      }
    }
    index += item.length
  }
  return mergeRanges(out)
}

function mergeRanges(ranges: { from: number; to: number }[]): { from: number; to: number }[] {
  ranges.sort((x, y) => x.from - y.from)
  const merged: { from: number; to: number }[] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && last.to >= r.from) last.to = Math.max(last.to, r.to)
    else merged.push({ ...r })
  }
  return merged
}

function relAt(text: YText, index: number, assoc: number): string {
  return bytesToBase64(Y_.encodeRelativePosition(Y_.createRelativePositionFromTypeIndex(text, index, assoc)) as Uint8Array)
}

function resolveRel(doc: YDoc, text: YText, encoded: string): number | null {
  try {
    const abs = Y_.createAbsolutePositionFromRelativePosition(Y_.decodeRelativePosition(base64ToBytes(encoded)), doc) as { type: unknown; index: number } | null
    return abs && abs.type === text ? abs.index : null
  } catch {
    return null
  }
}

// ── Suivre une ecriture ──────────────────────────────────────────────────────

/**
 * Note ce qu'une ecriture change dans le texte. `capture` entoure chaque
 * modification de l'agent, et seulement elle : une personne qui tape pendant
 * l'effet de frappe n'est pas comptee (ses frappes passent hors de capture).
 */
export class AiChangeTracker {
  readonly ops: AiChangeOp[] = []

  constructor(private readonly text: YText) {}

  capture<T>(fn: () => T): T {
    let before = this.text.toString()
    const handler = (event: { delta: { insert?: unknown; delete?: number; retain?: number }[] }): void => {
      let pos = 0
      let after = 0
      for (const d of event.delta) {
        if (d.retain) {
          pos += d.retain
          after += d.retain
        } else if (typeof d.insert === 'string') {
          this.addInsert(d.insert, idRunsAt(this.text, after, d.insert.length))
          after += d.insert.length
        } else if (d.delete) {
          this.ops.push({ kind: 'delete', text: before.slice(pos, pos + d.delete).slice(0, MAX_DELETED_TEXT), at: relAt(this.text, after, -1) })
          pos += d.delete
        }
      }
      before = this.text.toString()
    }
    this.text.observe(handler as never)
    try {
      return fn()
    } finally {
      this.text.unobserve(handler as never)
    }
  }

  /** La suite d'un texte (effet de frappe) prolonge l'insertion d'avant. */
  private addInsert(text: string, ids: IdRun[]): void {
    const last = this.ops[this.ops.length - 1]
    const lastRun = last?.kind === 'insert' ? last.ids[last.ids.length - 1] : undefined
    const first = ids[0]
    if (last?.kind === 'insert' && lastRun && first && lastRun[0] === first[0] && lastRun[1] + lastRun[2] === first[1]) {
      last.text += text
      lastRun[2] += first[2]
      last.ids.push(...ids.slice(1))
      return
    }
    this.ops.push({ kind: 'insert', text, ids })
  }
}

// ── La carte des points ──────────────────────────────────────────────────────

export function aiChangesMap(doc: YDoc): YMap {
  return doc.getMap(AI_CHANGES_MAP)
}

function isStored(v: unknown): v is StoredAiChange {
  const c = v as StoredAiChange | null
  return !!c && typeof c.at === 'string' && Array.isArray(c.ops) && !!c.agent && typeof c.agent.id === 'string'
}

/** Les points ranges, du plus ancien au plus recent. */
export function listAiChanges(doc: YDoc): { id: string; change: StoredAiChange }[] {
  const out: { id: string; change: StoredAiChange }[] = []
  aiChangesMap(doc).forEach((value: unknown, id: string) => { if (isStored(value)) out.push({ id, change: value }) })
  return out.sort((a, b) => a.change.at.localeCompare(b.change.at) || a.id.localeCompare(b.id))
}

const bucketOf = (c: StoredAiChange): number => Math.floor(Date.parse(c.at) / AI_CHANGE_BUCKET_MS)
const groupKey = (c: StoredAiChange): string => `${c.agent.id}|${c.forUser?.id ?? ''}|${bucketOf(c)}`
const closed = (c: StoredAiChange, now: number): boolean => now >= (bucketOf(c) + 1) * AI_CHANGE_BUCKET_MS + AI_CHANGE_SETTLE_MS

/** Fond des points (du plus ancien au plus recent) en un seul. */
function merge(parts: readonly StoredAiChange[]): StoredAiChange {
  const first = parts[0]!
  const lastAt = parts.reduce((m, p) => (p.last ?? p.at) > m ? (p.last ?? p.at) : m, first.last ?? first.at)
  return {
    at: first.at,
    ...(parts.length > 1 || first.last ? { last: lastAt } : {}),
    agent: first.agent,
    ...(first.forUser ? { forUser: first.forUser } : {}),
    summaries: parts.flatMap(p => p.summaries),
    reasons: [...new Set(parts.flatMap(p => p.reasons))],
    ops: parts.flatMap(p => p.ops),
    count: parts.reduce((n, p) => n + (p.count || 1), 0),
  }
}

/** Les groupes a fondre : meme agent, meme personne, meme tranche close ; jamais un point annule. */
function groups(list: readonly { id: string; change: StoredAiChange }[], now: number): { key: string; members: { id: string; change: StoredAiChange }[] }[] {
  const by = new Map<string, { id: string; change: StoredAiChange }[]>()
  for (const e of list) {
    if (e.change.undone || !closed(e.change, now)) continue
    const k = groupKey(e.change)
    const g = by.get(k) ?? []
    g.push(e)
    by.set(k, g)
  }
  return [...by].map(([key, members]) => ({ key, members }))
}

/** L'id d'un point compacte : le meme chez tous ceux qui compactent (ils ecrivent la meme chose). */
const compactId = (key: string): string => `c|${key}`

/**
 * Compacte ce qui est range : chaque groupe clos devient un point. Deux hotes
 * qui compactent en meme temps ecrivent la meme valeur sous la meme cle.
 * Rend le nombre de points retires.
 */
export function compactAiChanges(doc: YDoc, now = Date.now()): number {
  const map = aiChangesMap(doc)
  let removed = 0
  for (const { key, members } of groups(listAiChanges(doc), now)) {
    if (members.length < 2) continue
    const id = compactId(key)
    const merged = merge(members.map(m => m.change))
    for (const m of members) if (m.id !== id) { map.delete(m.id); removed++ }
    map.set(id, merged)
  }
  const all = listAiChanges(doc)
  for (const old of all.slice(0, Math.max(0, all.length - MAX_AI_CHANGES))) { map.delete(old.id); removed++ }
  return removed
}

const newId = (now: number): string => `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`

/**
 * Range le point d'une ecriture (a appeler dans la transaction de
 * l'ecriture, ou juste apres, sur le meme Y.Doc), puis compacte. Rien si
 * l'ecriture n'a rien change. Rend l'id du point.
 */
export function recordAiChange(doc: YDoc, ops: readonly AiChangeOp[], meta: AiChangeMeta, now = Date.now()): string | null {
  if (!ops.length) return null
  const id = newId(now)
  doc.transact(() => {
    const value: StoredAiChange = {
      at: new Date(now).toISOString(),
      agent: { id: meta.agent.id, name: meta.agent.name, ...(meta.agent.color ? { color: meta.agent.color } : {}) },
      ...(meta.forUser ? { forUser: meta.forUser } : {}),
      summaries: meta.summary ? [meta.summary] : [],
      reasons: meta.reason ? [meta.reason] : [],
      ops: ops.map(o => o.kind === 'insert' ? { kind: 'insert' as const, text: o.text, ids: o.ids.map(r => [...r] as IdRun) } : { ...o }),
      count: 1,
    }
    aiChangesMap(doc).set(id, value)
    compactAiChanges(doc, now)
  })
  return id
}

// ── Affichage ────────────────────────────────────────────────────────────────

function countChars(ops: readonly AiChangeOp[], kind: 'insert' | 'delete'): number {
  return ops.reduce((n, o) => n + (o.kind === kind ? o.text.length : 0), 0)
}

/**
 * Ce qu'on montre : les points, compactes par tranche close comme ils le
 * seront une fois ranges. Du plus recent au plus ancien. L'id d'un point
 * montre est celui de son premier point range ; `parts` les donne tous.
 */
export function displayAiChanges(doc: YDoc, now = Date.now()): AiChangeInfo[] {
  const list = listAiChanges(doc)
  const grouped = new Map<string, { id: string; change: StoredAiChange }[]>()
  for (const g of groups(list, now)) grouped.set(g.members[0]!.id, g.members)
  const inGroup = new Set([...grouped.values()].flatMap(m => m.map(x => x.id)))
  const out: AiChangeInfo[] = []
  for (const e of list) {
    if (inGroup.has(e.id) && !grouped.has(e.id)) continue
    const members = grouped.get(e.id) ?? [e]
    const c = members.length > 1 ? merge(members.map(m => m.change)) : e.change
    out.push({
      id: e.id,
      parts: members.map(m => m.id),
      at: c.at,
      ...(c.last ? { last: c.last } : {}),
      agent: c.agent,
      ...(c.forUser ? { forUser: c.forUser } : {}),
      summaries: c.summaries,
      reasons: c.reasons,
      count: c.count || 1,
      inserted: countChars(c.ops, 'insert'),
      deleted: countChars(c.ops, 'delete'),
      ...(c.undone ? { undone: c.undone } : {}),
    })
  }
  return out.reverse()
}

/** Ou sont aujourd'hui les traces de ces points : texte ajoute encore la, endroits des suppressions. */
export function aiChangeRanges(doc: YDoc, text: YText, ids: readonly string[]): AiChangeRanges {
  const map = aiChangesMap(doc)
  const inserted: { from: number; to: number }[] = []
  const deleted: { at: number; text: string }[] = []
  for (const id of ids) {
    const c = map.get(id)
    if (!isStored(c)) continue
    for (const op of c.ops) {
      if (op.kind === 'insert') inserted.push(...presentRanges(text, op.ids))
      else {
        const at = resolveRel(doc, text, op.at)
        if (at !== null && op.text) deleted.push({ at, text: op.text })
      }
    }
  }
  return { inserted: mergeRanges(inserted), deleted: deleted.sort((a, b) => a.at - b.at) }
}

// ── Annuler ──────────────────────────────────────────────────────────────────

export interface UndoResult {
  /** Au moins un point a ete annule. */
  ok: boolean
  /** Une partie n'a pas pu etre remise (endroit introuvable). */
  partial: boolean
}

/**
 * Annule ces points (les parts d'un point montre), du plus recent au plus
 * ancien, en une seule modification : le texte ajoute encore present part,
 * le texte supprime revient a sa place. Les points sont marques annules.
 * `origin` : l'origine de la transaction (celle de l'appli, pour qu'elle parte).
 */
export function undoAiChanges(doc: YDoc, text: YText, ids: readonly string[], by: AiChangeWho, now = Date.now(), origin?: unknown): UndoResult {
  const map = aiChangesMap(doc)
  const targets = ids
    .map(id => ({ id, change: map.get(id) }))
    .filter((e): e is { id: string; change: StoredAiChange } => isStored(e.change) && !e.change.undone)
    .sort((a, b) => b.change.at.localeCompare(a.change.at) || b.id.localeCompare(a.id))
  if (!targets.length) return { ok: false, partial: false }
  let partial = false
  doc.transact(() => {
    for (const { id, change } of targets) {
      for (let i = change.ops.length - 1; i >= 0; i--) {
        const op = change.ops[i]!
        if (op.kind === 'insert') {
          const ranges = presentRanges(text, op.ids)
          for (let j = ranges.length - 1; j >= 0; j--) text.delete(ranges[j]!.from, ranges[j]!.to - ranges[j]!.from)
        } else if (op.text) {
          const at = resolveRel(doc, text, op.at)
          if (at === null) { partial = true; continue }
          text.insert(Math.min(at, text.toString().length), op.text)
        }
      }
      map.set(id, { ...change, undone: { at: new Date(now).toISOString(), by } })
    }
  }, origin)
  return { ok: true, partial }
}
