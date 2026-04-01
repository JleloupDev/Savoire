// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
type Handler = (...args: unknown[]) => void

export class EventBus {
  private listeners = new Map<string, Set<Handler>>()

  on(event: string, handler: Handler): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(handler)
    return () => this.off(event, handler)
  }

  off(event: string, handler: Handler): void {
    this.listeners.get(event)?.delete(handler)
  }

  emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((h) => h(...args))
  }

  destroy(): void {
    this.listeners.clear()
  }
}

// Global singleton EventBus for cross-system communication.
export const globalEventBus = new EventBus()
