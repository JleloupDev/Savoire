// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Multi-account auth — matches client-web AuthStateService + IAccountStore logic
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import type { IAuthAPI } from '@savoire/application'
import { notify } from '@savoire/notifications'
import type { AccountEntry } from './types'
import { accountsAfterLogin, getAccountStorage } from './accountStorage'
import { isNetworkError } from './serverErrors'
import { createSessionRenewal, refreshOnce, SESSION_EXPIRED_MESSAGE, type SessionRenewal } from './session'

// Navigateur : sessionStorage. Version bureau : la session du serveur
// choisi, gardee sur la machine (voir accountStorage.ts, serverConnection.ts).
function loadAccounts(): AccountEntry[] {
  return getAccountStorage().load()
}

function saveAccounts(accounts: AccountEntry[]) {
  getAccountStorage().save(accounts)
}

interface AuthContextValue {
  // Active session
  token: string | null
  accounts: AccountEntry[]
  activeAccount: AccountEntry | null
  isReady: boolean

  // Actions
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  switchAccount: (userId: string) => Promise<boolean>
  /** Relit les comptes gardes (version bureau : apres un changement de serveur). */
  reloadAccounts: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * `singleAccount` : version bureau, un seul compte a la fois (se connecter
 * avec un autre compte remplace le precedent). Navigateur : plusieurs comptes,
 * bascule par le menu du compte.
 */
/**
 * `setTokenRenewer` : branche le rejeu des requetes refusees (401) sur le
 * renouvellement de la session (voir createWebServices).
 */
export function AuthProvider({ children, authApi, singleAccount = false, setTokenRenewer }: {
  children: ReactNode
  authApi: IAuthAPI
  singleAccount?: boolean
  setTokenRenewer?: (renewer: ((rejected: string) => Promise<string | null>) | null) => void
}) {
  const [accounts, setAccounts] = useState<AccountEntry[]>(loadAccounts)
  const [token, setToken] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)

  const activeAccount = accounts.find(a => a.isActive) ?? null

  // Renouvellement du jeton d'acces du compte actif (voir session.ts).
  const renewalRef = useRef<SessionRenewal | null>(null)
  renewalRef.current ??= createSessionRenewal({
    refresh: (refreshToken) => authApi.refresh(refreshToken),
    onRenewed: (accessToken, stored) => {
      setAccounts(stored)
      setToken(accessToken)
    },
    onExpired: (remaining) => {
      // Un seul message ; l'ecran de connexion suit (token null, voir AppShell).
      setAccounts(remaining)
      setToken(null)
      notify('warn', SESSION_EXPIRED_MESSAGE)
    },
  })
  const renewal = renewalRef.current

  useEffect(() => { renewal.setToken(token) }, [renewal, token])

  // Rejeu des requetes refusees (401), et reprise apres une mise en veille :
  // le minuteur a pu dormir, on regarde l'echeance au retour.
  useEffect(() => {
    setTokenRenewer?.(rejected => renewal.renewRejected(rejected))
    const check = () => { if (document.visibilityState !== 'hidden') renewal.check() }
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('online', check)
    return () => {
      setTokenRenewer?.(null)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('online', check)
      renewal.stop()
    }
  }, [renewal, setTokenRenewer])

  const login = useCallback(async (email: string, password: string) => {
    const res = await authApi.login(email, password)
    const newEntry: AccountEntry = {
      userId: res.user.id,
      email: res.user.email,
      displayName: res.user.displayName,
      refreshToken: res.refreshToken,
      isActive: true,
    }
    const final = accountsAfterLogin(loadAccounts(), newEntry, singleAccount)
    saveAccounts(final)
    setAccounts(final)
    setToken(res.accessToken)
  }, [authApi, singleAccount])

  const logout = useCallback(async () => {
    const current = loadAccounts().find(a => a.isActive)
    if (current && token) {
      try { await authApi.logout(token, current.refreshToken) } catch { /* POC: ignore */ }
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
      // Meme jeton qu'un renouvellement en cours : on attend sa reponse.
      const res = await refreshOnce(t => authApi.refresh(t), target.refreshToken)
      const updated = stored.map(a => ({
        ...a,
        isActive: a.userId === userId,
        refreshToken: a.userId === userId ? res.refreshToken : a.refreshToken,
      }))
      saveAccounts(updated)
      setAccounts(updated)
      setToken(res.accessToken)
      return true
    } catch (err) {
      // Serveur injoignable : le compte reste garde, on reessaiera plus tard.
      if (isNetworkError(err)) return false
      // Refresh token expired — remove that account
      const filtered = stored.filter(a => a.userId !== userId)
      saveAccounts(filtered)
      setAccounts(filtered)
      return false
    }
  }, [])

  const reloadAccounts = useCallback(() => {
    setAccounts(loadAccounts())
    setToken(null)
  }, [])

  // On mount: restore session from stored refresh token — delegates to switchAccount
  // to avoid duplicating the token-rotation + account-update logic.
  useEffect(() => {
    const active = loadAccounts().find(a => a.isActive)
    if (!active) { setIsReady(true); return }
    void switchAccount(active.userId).finally(() => setIsReady(true))
  }, [switchAccount])

  return (
    <AuthContext.Provider value={{ token, accounts, activeAccount, isReady, login, logout, switchAccount, reloadAccounts }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
