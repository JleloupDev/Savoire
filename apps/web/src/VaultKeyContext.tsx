// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// K_User — per-account key that unwraps this account's escrowed vault Keyrings
// (see VaultKeyEscrow.ts). Deliberately memory-only: never written to
// sessionStorage/localStorage/IndexedDB, so it is re-entered every reload
// (VaultKeyGate.tsx) — see docs/Architecture, K_User escrow design. A
// Map<userId, Uint8Array> because the app juggles several accounts at once,
// exactly like AuthContext's AccountEntry[].
import { createContext, useContext, useRef, useState, useCallback, type ReactNode } from 'react'

interface VaultKeyContextValue {
  hasVaultKey(userId: string): boolean
  getVaultKey(userId: string): Uint8Array | null
  setVaultKey(userId: string, key: Uint8Array): void
  clearVaultKey(userId: string): void
  /** Bumped on every set/clear, any account — a cheap dependency for effects
   *  that need to re-run "whenever some key changed" (e.g. AppShell's
   *  per-vault lock probe) without comparing key bytes themselves. */
  keyVersion: number
}

const VaultKeyContext = createContext<VaultKeyContextValue | null>(null)

export function VaultKeyProvider({ children }: { children: ReactNode }) {
  const keysRef = useRef(new Map<string, Uint8Array>())
  // keysRef is never read reactively (mutated in place) —
  // keyVersion exists to re-render context consumers (e.g. AppShell) after
  // any mutation, and is also exposed directly (see above).
  const [keyVersion, bump] = useState(0)

  const hasVaultKey = useCallback((userId: string) => keysRef.current.has(userId), [])
  const getVaultKey = useCallback((userId: string) => keysRef.current.get(userId) ?? null, [])

  const setVaultKey = useCallback((userId: string, key: Uint8Array) => {
    keysRef.current.set(userId, key)
    bump(n => n + 1)
  }, [])

  const clearVaultKey = useCallback((userId: string) => {
    keysRef.current.delete(userId)
    bump(n => n + 1)
  }, [])

  return (
    <VaultKeyContext.Provider value={{ hasVaultKey, getVaultKey, setVaultKey, clearVaultKey, keyVersion }}>
      {children}
    </VaultKeyContext.Provider>
  )
}

export function useVaultKey(): VaultKeyContextValue {
  const ctx = useContext(VaultKeyContext)
  if (!ctx) throw new Error('useVaultKey must be used inside VaultKeyProvider')
  return ctx
}
