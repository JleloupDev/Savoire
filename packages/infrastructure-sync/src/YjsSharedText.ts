// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adaptateur Yjs -> ISharedText (@savoire/plugin-api). Les plugins ne voient
// jamais Yjs : ils recoivent des deltas retain/insert/delete et une origine.
// Voir docs/Architecture/plugin-crdt-api.md.
//
// Origine : une transaction locale (frappe dans ce client, quelle que soit la
// vue) donne 'local' ; une mise a jour appliquee depuis le reseau
// (Y.applyUpdate) donne 'remote'. On lit transaction.local, pas l'origine
// posee par l'appelant : c'est Yjs qui sait si la transaction vient d'ailleurs.
//
// Les attributs de format des deltas Yjs sont ignores : le contrat ne parle
// que de texte brut. Les inserts non textuels (embeds) sont ignores aussi :
// le texte d'un document n'en contient pas.
import * as Y from 'yjs'
import type { ChangeOrigin, ISharedText, TextDelta, TextDeltaOp } from '@savoire/plugin-api'

interface YDeltaOp {
  insert?: unknown
  retain?: number
  delete?: number
}

interface YTextEventLike {
  delta: YDeltaOp[]
  transaction: { local: boolean }
}

// Meme contournement que YjsCollaborativeText : TS 5.9 + moduleResolution
// bundler suit mal les types herites de Y.Text (length, observe...).
interface YTextLike {
  readonly length: number
  readonly doc: { transact(f: () => void, origin?: unknown): void } | null
  toString(): string
  insert(index: number, text: string): void
  delete(index: number, length: number): void
  observe(f: (event: YTextEventLike) => void): void
  unobserve(f: (event: YTextEventLike) => void): void
}

/** Traduit un delta Yjs en delta du contrat, sans attributs ni embeds. */
export function fromYjsDelta(delta: YDeltaOp[]): TextDelta {
  const out: TextDelta = []
  for (const op of delta) {
    let next: TextDeltaOp | null = null
    if (typeof op.retain === 'number') next = { retain: op.retain }
    else if (typeof op.delete === 'number') next = { delete: op.delete }
    else if (typeof op.insert === 'string') next = { insert: op.insert }
    if (next) out.push(next)
  }
  return out
}

export class YjsSharedText implements ISharedText {
  private readonly ytext: YTextLike
  private readonly listeners = new Set<(delta: TextDelta, origin: ChangeOrigin) => void>()
  private readonly handler = (event: YTextEventLike): void => {
    const delta = fromYjsDelta(event.delta)
    if (delta.length === 0) return
    const origin: ChangeOrigin = event.transaction.local ? 'local' : 'remote'
    for (const cb of [...this.listeners]) cb(delta, origin)
  }

  constructor(ytext: Y.Text) {
    this.ytext = ytext as unknown as YTextLike
    this.ytext.observe(this.handler)
  }

  toString(): string {
    return this.ytext.toString()
  }

  get length(): number {
    return this.ytext.length
  }

  insert(index: number, text: string): void {
    if (text) this.ytext.insert(index, text)
  }

  delete(index: number, length: number): void {
    if (length > 0) this.ytext.delete(index, length)
  }

  applyDelta(delta: TextDelta): void {
    // Une seule transaction : les pairs et les abonnes voient une seule
    // modification. Pas de Y.Text.applyDelta : son option « sanitize »
    // retire un saut de ligne final, ce que le contrat ne prevoit pas.
    const run = (): void => {
      let pos = 0
      for (const op of delta) {
        if ('retain' in op) pos += op.retain
        else if ('delete' in op) { if (op.delete > 0) this.ytext.delete(pos, op.delete) }
        else if (op.insert) { this.ytext.insert(pos, op.insert); pos += op.insert.length }
      }
    }
    if (this.ytext.doc) this.ytext.doc.transact(run, this)
    else run()
  }

  onChange(cb: (delta: TextDelta, origin: ChangeOrigin) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Detache l'adaptateur du Y.Text. Les abonnes ne recoivent plus rien. */
  dispose(): void {
    this.ytext.unobserve(this.handler)
    this.listeners.clear()
  }
}
