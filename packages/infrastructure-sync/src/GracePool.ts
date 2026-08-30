// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Grace pool: shares one live resource per key across React effect churn
// (StrictMode double-mount, editor mode changes). Without it, every remount of
// the editor destroys and recreates the edgesync bundle (Y.Doc adapter +
// protocol session) — and when the destroyed session was the key holder
// (owner rule), its genesis keys die with it: nobody can grant anymore.
// A leased resource is only really disposed after a grace period with no
// holders; quick unmount/remount cycles keep the SAME instance (keys intact).

interface PoolEntry<T> {
  value: T
  refs: number
  timer?: ReturnType<typeof setTimeout>
}

export interface PoolLease<T> {
  value: T
  release: () => void
}

export class GracePool<T> {
  private readonly entries = new Map<string, PoolEntry<T>>()

  constructor(
    private readonly disposer: (value: T) => void,
    private readonly graceMs = 5000,
  ) {}

  acquire(key: string, create: () => T): PoolLease<T> {
    let entry = this.entries.get(key)
    if (!entry) {
      entry = { value: create(), refs: 0 }
      this.entries.set(key, entry)
    }
    if (entry.timer) {
      clearTimeout(entry.timer)
      entry.timer = undefined
    }
    entry.refs++
    const held = entry
    let released = false
    return {
      value: entry.value,
      release: () => {
        if (released) return // a lease releases at most once
        released = true
        this.releaseEntry(key, held)
      },
    }
  }

  /** Drop a broken entry so the next acquire recreates it (no dispose call). */
  evict(key: string, ifValue?: T): void {
    const entry = this.entries.get(key)
    if (!entry) return
    if (ifValue !== undefined && entry.value !== ifValue) return
    if (entry.timer) clearTimeout(entry.timer)
    this.entries.delete(key)
  }

  private releaseEntry(key: string, entry: PoolEntry<T>): void {
    entry.refs--
    if (entry.refs > 0) return
    entry.timer = setTimeout(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      this.disposer(entry.value)
    }, this.graceMs)
  }
}
