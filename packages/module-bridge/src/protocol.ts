// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Module bridge protocol — messages exchanged between the host page (note editor)
// and the module iframe (isolated plugin context).
//
// see ADR-018

// ── Module → Host ────────────────────────────────────────────────────────────

export type VaultRequest =
  | { type: 'vault:read';              id: string; docId: string }
  | { type: 'vault:readByPath';        id: string; path: string }
  | { type: 'vault:write';             id: string; docId: string; content: string }
  | { type: 'vault:exists';            id: string; docId: string }
  | { type: 'vault:resolveDocumentId'; id: string; path: string }

/** Module finished loading and is ready to receive messages. */
export interface ModuleReady { type: 'module:ready' }

/** Module requests a height change on its iframe (auto-sizing). */
export interface ModuleResize { type: 'module:resize'; height: number }

export type ModuleToHostMsg = VaultRequest | ModuleReady | ModuleResize

// ── Host → Module ────────────────────────────────────────────────────────────

/** Response to a VaultRequest. */
export interface VaultResponse {
  type: 'vault:response'
  id: string
  result?: unknown
  error?: string
}

/**
 * Pre-loaded content pushed by the host right after module:ready.
 */
export interface VaultPreload {
  type: 'vault:preload'
  path: string
  content: string   // raw file content (empty string if file did not exist)
  docId?: string    // resolved document id (for writes)
}

/** Push a fresh snapshot to the module (real-time sync from another user). */
export interface VaultSnapshot {
  type: 'vault:snapshot'
  docId: string
  content: string
}

export type HostToModuleMsg = VaultResponse | VaultPreload | VaultSnapshot
