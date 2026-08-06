// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// K_User — per-account key that unwraps this account's escrowed vault Keyrings
// (see VaultKeyEscrow.ts). Deliberately memory-only: never written to
// sessionStorage/localStorage/IndexedDB, so it is re-entered every reload
// (VaultKeyGate.tsx) — see docs/Architecture, K_User escrow design. A
// Map<userId, Uint8Array> because the app juggles several accounts at once,
// exactly like AuthContext's AccountEntry[].
import { createContext, useContext, useRef, useState, useCallback, type ReactNode } from 'react'

// S2 pour K_User (voir ServerVaultKeyProvider.ts) : quels comptes ont choisi de
// laisser le serveur gerer leur cle. Uniquement ce flag — jamais K_User
// lui-meme. Meme mecanisme que AuthContext.tsx's STORE_KEY (sessionStorage) —
// c'est une preference, pas un secret, donc pas soumis a la regle
// memory-only de K_User ci-dessus.
const SERVER_MANAGED_KEY = 'vault_key_server_managed'

function loadServerManaged(): Set<string> {
  try {
    const raw = sessionStorage.getItem(SERVER_MANAGED_KEY)
    return new Set(raw ? JSON.parse(raw) as string[] : [])
  } catch { return new Set() }
}

function saveServerManaged(s: Set<string>) {
  sessionStorage.setItem(SERVER_MANAGED_KEY, JSON.stringify([...s]))
}

interface VaultKeyContextValue {
  hasVaultKey(userId: string): boolean
  getVaultKey(userId: string): Uint8Array | null
  setVaultKey(userId: string, key: Uint8Array): void
  clearVaultKey(userId: string): void
  /** S2: true once this account has chosen "let the server manage my key" —
   *  drives AppShell's silent auto-fetch on future logins (VaultKeyGate.tsx's
   *  ServerManaged mode sets this once, right after the first successful
   *  fetchOrCreate()). Never cleared on logout — the preference belongs to
   *  the account, not the session, same as AuthContext's own account list. */
  isServerManaged(userId: string): boolean
  setServerManaged(userId: string): void
  /** Bumped on every set/clear, any account — a cheap dependency for effects
   *  that need to re-run "whenever some key changed" (e.g. AppShell's
   *  per-vault lock probe) without comparing key bytes themselves. */
  keyVersion: number
}

const VaultKeyContext = createContext<VaultKeyContextValue | null>(null)

export function VaultKeyProvider({ children }: { children: ReactNode }) {
  const keysRef = useRef(new Map<string, Uint8Array>())
  const serverManagedRef = useRef(loadServerManaged())
  // keysRef/serverManagedRef are never read reactively (mutated in place) —
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

  const isServerManaged = useCallback((userId: string) => serverManagedRef.current.has(userId), [])

  const setServerManaged = useCallback((userId: string) => {
    serverManagedRef.current.add(userId)
    saveServerManaged(serverManagedRef.current)
    bump(n => n + 1)
  }, [])

  return (
    <VaultKeyContext.Provider value={{ hasVaultKey, getVaultKey, setVaultKey, clearVaultKey, isServerManaged, setServerManaged, keyVersion }}>
      {children}
    </VaultKeyContext.Provider>
  )
}

export function useVaultKey(): VaultKeyContextValue {
  const ctx = useContext(VaultKeyContext)
  if (!ctx) throw new Error('useVaultKey must be used inside VaultKeyProvider')
  return ctx
}
