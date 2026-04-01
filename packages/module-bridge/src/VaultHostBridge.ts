// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// VaultHostBridge — lives in the HOST page (plugin-module widget).
// It relays VaultRequest messages arriving from the module iframe to the real
// VaultAPI, then posts VaultResponse back into the iframe.
//

import type { VaultAPI } from '@savoire/plugin-api'
import type {
  VaultRequest,
  VaultResponse,
  VaultSnapshot,
} from './protocol'

export class VaultHostBridge {
  readonly #vault: VaultAPI
  readonly #iframe: HTMLIFrameElement
  #iframeWindow: Window | null = null
  #disposed = false

  constructor(vault: VaultAPI, iframe: HTMLIFrameElement) {
    this.#vault = vault
    this.#iframe = iframe
    // Capture the stable contentWindow after the page finishes loading.
    iframe.addEventListener('load', () => {
      this.#iframeWindow = iframe.contentWindow
      console.log('[VaultHostBridge] iframe load event fired, contentWindow captured:', !!this.#iframeWindow)
    })
    window.addEventListener('message', this.#onMessage)
  }

  dispose(): void {
    this.#disposed = true
    window.removeEventListener('message', this.#onMessage)
  }

  // ── Push a snapshot into the iframe (call from outside when vault changes) ─

  pushSnapshot(docId: string, content: string): void {
    if (this.#disposed) return
    const msg: VaultSnapshot = { type: 'vault:snapshot', docId, content }
    this.#post(msg)
  }

  // ── inbound from iframe ───────────────────────────────────────────────────

  #onMessage = async (ev: MessageEvent): Promise<void> => {
    if (this.#disposed) return

    const msg = ev.data as Record<string, unknown>
    if (!msg || typeof msg !== 'object') return

    if (typeof msg['type'] !== 'string' || !msg['type'].startsWith('vault:')) return

    const req = msg as unknown as VaultRequest
    console.log(`[VaultHostBridge] incoming ${req.type} id=${req.id}`)
    await this.#handle(req)
  }

  async #handle(req: VaultRequest): Promise<void> {
    try {
      let result: unknown
      switch (req.type) {
        case 'vault:read':
          result = await this.#vault.read(req.docId)
          break
        case 'vault:readByPath':
          result = await this.#vault.readDocumentByPath(req.path)
          break
        case 'vault:write':
          result = await this.#vault.write(req.docId, req.content)
          break
        case 'vault:exists':
          result = await this.#vault.exists?.(req.docId)
          break
        case 'vault:resolveDocumentId':
          result = this.#vault.resolveDocumentId?.(req.path)
          break
      }
      console.log(`[VaultHostBridge] responding to ${req.id} result type=${typeof result}`)
      this.#post({ type: 'vault:response', id: req.id, result } satisfies VaultResponse)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.warn(`[VaultHostBridge] ERROR handling ${req.type}:`, error)
      this.#post({ type: 'vault:response', id: req.id, error } satisfies VaultResponse)
    }
  }

  #post(msg: VaultResponse | VaultSnapshot): void {
    const win = this.#iframeWindow ?? this.#iframe.contentWindow
    win?.postMessage(msg, '*')
  }
}
