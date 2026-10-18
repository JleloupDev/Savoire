// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pont Tauri simule : enregistre les commandes, rend des reponses prevues,
// et laisse le test emettre des evenements.

import type { InvokeOptions, TauriBridge } from '@savoire/desktop'

export interface Call {
  cmd: string
  args?: Record<string, unknown> | Uint8Array
  options?: InvokeOptions
}

export class FakeBridge implements TauriBridge {
  readonly calls: Call[] = []
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  private readonly handlers = new Map<string, (args: Call['args']) => unknown>()

  on(cmd: string, handler: (args: Call['args']) => unknown): this {
    this.handlers.set(cmd, handler)
    return this
  }

  async invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, options?: InvokeOptions): Promise<T> {
    this.calls.push({ cmd, args, options })
    const handler = this.handlers.get(cmd)
    return (handler ? await handler(args) : undefined) as T
  }

  async listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
    let set = this.listeners.get(event)
    if (!set) { set = new Set(); this.listeners.set(event, set) }
    const fn = cb as (payload: unknown) => void
    set.add(fn)
    return () => { set.delete(fn) }
  }

  emit(event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) cb(payload)
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0
  }

  commands(): string[] {
    return this.calls.map(c => c.cmd)
  }
}

/** Laisse passer les promesses en attente. */
export const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
