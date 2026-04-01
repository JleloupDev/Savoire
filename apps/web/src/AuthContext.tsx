// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Multi-account auth — matches client-web AuthStateService + IAccountStore logic
import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'
import type { AccountEntry, AuthResponse } from './types'
import { api } from './api'

const STORE_KEY = 'vault_accounts'

function loadAccounts(): AccountEntry[] {
  try {
    const raw = sessionStorage.getItem(STORE_KEY)
    return raw ? (JSON.parse(raw) as AccountEntry[]) : []
  } catch { return [] }
}

function saveAccounts(accounts: AccountEntry[]) {
  sessionStorage.setItem(STORE_KEY, JSON.stringify(accounts))
}

interface AuthContextValue {
  // Active session
  token: string | null
  accounts: AccountEntry[]
  activeAccount: AccountEntry | null

  // Actions
  login: (res: AuthResponse) => void
  logout: () => Promise<void>
  switchAccount: (userId: string) => Promise<boolean>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<AccountEntry[]>(loadAccounts)
  const [token, setToken] = useState<string | null>(() => {
    // On reload, we have no access token in memory (expired anyway) — user must re-login or switch
    // But we keep the accounts list to show who was connected
    return null
  })

  const activeAccount = accounts.find(a => a.isActive) ?? null

  const login = useCallback((res: AuthResponse) => {
    const existing = loadAccounts()
    const updated = existing
      .map(a => ({ ...a, isActive: false }))
      .filter(a => a.userId !== res.user.id)

    const newEntry: AccountEntry = {
      userId: res.user.id,
      email: res.user.email,
      displayName: res.user.displayName,
      refreshToken: res.refreshToken,
      isActive: true,
    }
    const final = [...updated, newEntry]
    saveAccounts(final)
    setAccounts(final)
    setToken(res.accessToken)
  }, [])

  const logout = useCallback(async () => {
    const current = loadAccounts().find(a => a.isActive)
    if (current && token) {
      try { await api.logout(token, current.refreshToken) } catch { /* POC: ignore */ }
    }
    const remaining = loadAccounts().filter(a => !a.isActive)
    saveAccounts(remaining)
    setAccounts(remaining)
    setToken(null)
  }, [token])

  const switchAccount = useCallback(async (userId: string): Promise<boolean> => {
    const stored = loadAccounts()
    const target = stored.find(a => a.userId === userId)
    if (!target) return false
    try {
      const res = await api.refresh(target.refreshToken)
      const updated = stored.map(a => ({
        ...a,
        isActive: a.userId === userId,
        refreshToken: a.userId === userId ? res.refreshToken : a.refreshToken,
      }))
      saveAccounts(updated)
      setAccounts(updated)
      setToken(res.accessToken)
      return true
    } catch {
      // Refresh token expired — remove that account
      const filtered = stored.filter(a => a.userId !== userId)
      saveAccounts(filtered)
      setAccounts(filtered)
      return false
    }
  }, [])

  return (
    <AuthContext.Provider value={{ token, accounts, activeAccount, login, logout, switchAccount }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
