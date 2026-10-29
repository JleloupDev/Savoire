// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { IIndexChannel } from '@savoire/plugin-api'

/** Carte partagee en memoire ; deux cartes reliees simulent deux membres. */
export class MemChannel implements IIndexChannel {
  private readonly map = new Map<string, unknown>()
  private readonly cbs = new Set<(ids: string[]) => void>()
  private readonly peers = new Set<MemChannel>()
  static link(a: MemChannel, b: MemChannel): void { a.peers.add(b); b.peers.add(a) }
  set(id: string, v: unknown): void { this.apply(id, v); for (const p of this.peers) p.apply(id, v) }
  delete(id: string): void { this.apply(id, undefined); for (const p of this.peers) p.apply(id, undefined) }
  getAll() { return [...this.map].map(([id, value]) => ({ id, value })) }
  onChange(cb: (ids: string[]) => void) { this.cbs.add(cb); return () => { this.cbs.delete(cb) } }
  dispose(): void {}
  private apply(id: string, v: unknown): void {
    if (v === undefined) this.map.delete(id); else this.map.set(id, v)
    for (const cb of [...this.cbs]) cb([id])
  }
}

