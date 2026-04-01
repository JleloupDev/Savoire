// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// IframeVaultAPI — VaultAPI implementation for use *inside* the module iframe.
//
// see ADR-010

import type { VaultAPI } from '@savoire/plugin-api'
import type { VaultRequest, HostToModuleMsg, VaultPreload } from './protocol'

type Resolver = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class IframeVaultAPI implements VaultAPI {
  readonly #pending  = new Map<string, Resolver>()
  readonly #cache    = new Map<string, string>()   // path → content
  readonly #docIds   = new Map<string, string>()   // path → docId

  // Resolves when the host has sent vault:preload (or immediately if already received)
  #preloadResolve: (() => void) | null = null
  readonly #preloadReady: Promise<void>

  constructor() {
    this.#preloadReady = new Promise(res => { this.#preloadResolve = res })
    window.addEventListener('message', this.#onMessage)
  }

  /** Call once when the module unloads to avoid listener leaks. */
  dispose(): void {
    window.removeEventListener('message', this.#onMessage)
  }

  // ── inbound ────────────────────────────────────────────────────────────────

  #onMessage = (ev: MessageEvent): void => {
    const msg = ev.data as HostToModuleMsg
    if (!msg || typeof msg !== 'object' || typeof (msg as unknown as Record<string,unknown>)['type'] !== 'string') return

    switch (msg.type) {
      case 'vault:preload':
        this.#applyPreload(msg)
        break
      case 'vault:response': {
        const r = this.#pending.get(msg.id)
        if (!r) return
        this.#pending.delete(msg.id)
        if (msg.error) r.reject(new Error(msg.error))
        else r.resolve(msg.result)
        break
      }
      case 'vault:snapshot':
        this.#snapshotHandlers.forEach(h => h(msg.docId, msg.content))
        break
    }
  }

  #applyPreload(msg: VaultPreload): void {
    console.log(`[IframeVaultAPI] applyPreload: path="${msg.path}" content.len=${msg.content.length} docId=${msg.docId}`)
    this.#cache.set(msg.path, msg.content)
    if (msg.docId) this.#docIds.set(msg.path, msg.docId)
    this.#preloadResolve?.()
    this.#preloadResolve = null  // idempotent
  }

  /** Public entry-point for external preload seeding (embedded view bootstrap). */
  applyPreload(path: string, content: string, docId?: string): void {
    this.#applyPreload({ type: 'vault:preload', path, content, docId })
  }

  // ── snapshot subscription ─────────────────────────────────────────────────

  #snapshotHandlers = new Set<(docId: string, content: string) => void>()

  onSnapshot(handler: (docId: string, content: string) => void): () => void {
    this.#snapshotHandlers.add(handler)
    return () => this.#snapshotHandlers.delete(handler)
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  #send<T>(req: VaultRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(req.id, {
        resolve: v => resolve(v as T),
        reject,
      })
      window.parent.postMessage(req, '*')
    })
  }

  #id(): string { return crypto.randomUUID() }

  // ── VaultAPI implementation ───────────────────────────────────────────────

  async read(docId: string): Promise<string> {
    return this.#send<string>({ type: 'vault:read', id: this.#id(), docId })
  }

  async readDocumentByPath(path: string): Promise<string> {
    // Wait for host to send preload before trying the cache.
    // Timeout of 5 s so a stalled host doesn't block the render forever.
    console.log(`[IframeVaultAPI] readDocumentByPath("${path}") — waiting for preload (5s timeout)...`)
    const start = Date.now()
    await Promise.race([
      this.#preloadReady,
      new Promise<void>(res => setTimeout(res, 5000)),
    ])
    console.log(`[IframeVaultAPI] readDocumentByPath — preload wait done after ${Date.now()-start}ms, cache size=${this.#cache.size}`)
    const cached = this.#cache.get(path)
    if (cached !== undefined) {
      console.log(`[IframeVaultAPI] cache HIT for "${path}" (${cached.length} chars)`)
      return cached
    }
    // Fallback: bridge request (e.g. for files not included in preload)
    console.warn(`[IframeVaultAPI] cache MISS for "${path}" — sending bridge request vault:readByPath`)
    return this.#send<string>({ type: 'vault:readByPath', id: this.#id(), path })
  }

  async write(docId: string, content: string): Promise<void> {
    return this.#send<void>({ type: 'vault:write', id: this.#id(), docId, content })
  }

  async exists(docId: string): Promise<boolean> {
    return this.#send<boolean>({ type: 'vault:exists', id: this.#id(), docId })
  }

  resolveDocumentId(path: string): string | undefined {
    return this.#docIds.get(path)
  }

  async list(_dir?: string): Promise<string[]> { return [] }
}
