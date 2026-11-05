// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Multi-account auth — matches client-web AuthStateService + IAccountStore logic.
//
// La connexion se fait chez le fournisseur d'identite du serveur (ADR-028) :
// voir loginFlow.ts (navigateur : redirection ; bureau : navigateur du
// systeme et retour sur 127.0.0.1).
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import type { AppAuthResponse, IAuthAPI, LoginPrompt } from '@savoire/application'
import { notify } from '@savoire/notifications'
import type { AccountEntry } from './types'
import { accountsAfterLogin, getAccountStorage } from './accountStorage'
import { httpStatusOf, isNetworkError } from './serverErrors'
import { createSessionRenewal, refreshOnce, SESSION_EXPIRED_MESSAGE, type SessionRenewal } from './session'
import { describeAuthError, readLoginCallback, type LoginDriver } from './loginFlow'

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
  /** Echec du dernier retour de connexion, dit en clair (ecran de connexion). */
  loginError: string | null

  // Actions
  /**
   * Se connecter chez le fournisseur d'identite. Navigateur : la page part
   * (la promesse ne se resout pas). Bureau : se resout une fois connecte.
   * `prompt` : 'create' ouvre directement l'inscription.
   */
  login: (prompt?: LoginPrompt) => Promise<void>
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
 *
 * `setTokenRenewer` : branche le rejeu des requetes refusees (401) sur le
 * renouvellement de la session (voir createWebServices).
 *
 * `loginDriver` : comment aller chez le fournisseur d'identite (loginFlow.ts).
 */
export function AuthProvider({ children, authApi, loginDriver, singleAccount = false, setTokenRenewer }: {
  children: ReactNode
  authApi: IAuthAPI
  loginDriver: LoginDriver
  singleAccount?: boolean
  setTokenRenewer?: (renewer: ((rejected: string) => Promise<string | null>) | null) => void
}) {
  const [accounts, setAccounts] = useState<AccountEntry[]>(loadAccounts)
  const [token, setToken] = useState<string | null>(null)
  const [isReady, setIsReady] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  // Retour du fournisseur (/auth/callback) : lu au premier rendu, avant que
  // le routeur ne renvoie ailleurs.
  const [callback] = useState(() => readLoginCallback())

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

  const acceptLogin = useCallback((res: AppAuthResponse) => {
    const newEntry: AccountEntry = {
      userId: res.user.id,
      email: res.user.email,
      displayName: res.user.displayName,
      refreshToken: res.refreshToken,
      ...(res.idToken ? { idToken: res.idToken } : {}),
      isActive: true,
    }
    const final = accountsAfterLogin(loadAccounts(), newEntry, singleAccount)
    saveAccounts(final)
    setAccounts(final)
    setToken(res.accessToken)
    setLoginError(null)
  }, [singleAccount])

  const login = useCallback(async (prompt?: LoginPrompt) => {
    setLoginError(null)
    // Navigateur : la page part chez le fournisseur ; rien a recevoir ici.
    const res = await loginDriver.start(authApi, prompt)
    if (res) acceptLogin(res)
  }, [authApi, loginDriver, acceptLogin])

  const logout = useCallback(async () => {
    const current = loadAccounts().find(a => a.isActive)
    if (current && token) {
      try { await authApi.logout(token, current.refreshToken) } catch { /* meilleur effort */ }
    }
    const remaining = loadAccounts().filter(a => !a.isActive)
    saveAccounts(remaining)
    setAccounts(remaining)
    setToken(null)
    // Fin de la session du fournisseur aussi : sinon « Se connecter » repasse
    // sans rien demander, avec le meme compte (poste partage).
    await loginDriver.endSession?.(authApi, current?.idToken)
  }, [token, authApi, loginDriver])

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
        idToken: a.userId === userId ? (res.idToken ?? a.idToken) : a.idToken,
      }))
      saveAccounts(updated)
      setAccounts(updated)
      setToken(res.accessToken)
      return true
    } catch (err) {
      // Serveur injoignable ou en panne : le compte reste garde, on reessaiera plus tard.
      if (isNetworkError(err) || (httpStatusOf(err) ?? 0) >= 500) return false
      // Jeton de renouvellement refuse (expire, revoque) : ce compte part.
      const filtered = stored.filter(a => a.userId !== userId)
      saveAccounts(filtered)
      setAccounts(filtered)
      return false
    }
  }, [authApi])

  const reloadAccounts = useCallback(() => {
    setAccounts(loadAccounts())
    setToken(null)
  }, [])

  // Au demarrage : retour du fournisseur d'identite, sinon reprise de la
  // session gardee (jeton de renouvellement du compte actif).
  useEffect(() => {
    let cancelled = false
    void (async () => {
      if (callback) {
        try {
          const res = await loginDriver.complete(authApi, callback)
          if (!cancelled && res) acceptLogin(res)
        } catch (err) {
          if (!cancelled) setLoginError(describeAuthError(err))
        } finally {
          if (!cancelled) setIsReady(true)
        }
        return
      }
      const active = loadAccounts().find(a => a.isActive)
      if (active) await switchAccount(active.userId)
      if (!cancelled) setIsReady(true)
    })()
    return () => { cancelled = true }
  }, [callback, authApi, loginDriver, acceptLogin, switchAccount])

  return (
    <AuthContext.Provider value={{ token, accounts, activeAccount, isReady, loginError, login, logout, switchAccount, reloadAccounts }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
