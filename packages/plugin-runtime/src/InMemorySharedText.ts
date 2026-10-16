// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Implementation de reference de ISharedText, en memoire, sans CRDT. Sert
// aux tests des plugins et a l'editeur seul. Deux instances reliees par
// link() simulent deux membres : ce que l'une ecrit arrive chez l'autre
// comme un changement distant (sans fusion concurrente : les ecritures sont
// appliquees dans l'ordre, ce qui suffit pour des tests deterministes).
import type { ChangeOrigin, ISharedText, TextDelta } from '@savoire/plugin-api'

/** Applique un delta a un texte. */
export function applyTextDelta(text: string, delta: TextDelta): string {
  let out = ''
  let pos = 0
  for (const op of delta) {
    if ('retain' in op) {
      out += text.slice(pos, pos + op.retain)
      pos += op.retain
    } else if ('delete' in op) {
      pos += op.delete
    } else {
      out += op.insert
    }
  }
  return out + text.slice(pos)
}

export class InMemorySharedText implements ISharedText {
  private value: string
  private readonly listeners = new Set<(delta: TextDelta, origin: ChangeOrigin) => void>()
  private readonly peers = new Set<InMemorySharedText>()

  constructor(initial = '') {
    this.value = initial
  }

  /** Relie deux textes : chacun recoit les ecritures de l'autre. */
  static link(a: InMemorySharedText, b: InMemorySharedText): void {
    a.peers.add(b)
    b.peers.add(a)
  }

  toString(): string {
    return this.value
  }

  get length(): number {
    return this.value.length
  }

  insert(index: number, text: string): void {
    if (text) this.applyDelta([{ retain: index }, { insert: text }])
  }

  delete(index: number, length: number): void {
    if (length > 0) this.applyDelta([{ retain: index }, { delete: length }])
  }

  applyDelta(delta: TextDelta): void {
    this.receive(delta, 'local')
    for (const peer of this.peers) peer.receive(delta, 'remote')
  }

  onChange(cb: (delta: TextDelta, origin: ChangeOrigin) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  private receive(delta: TextDelta, origin: ChangeOrigin): void {
    this.value = applyTextDelta(this.value, delta)
    for (const cb of [...this.listeners]) cb(delta, origin)
  }
}
