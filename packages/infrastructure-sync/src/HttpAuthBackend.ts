// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connexion par le fournisseur d'identite du serveur (ADR-028), en OpenID
// Connect : « authorization code » + PKCE, sans secret (appli publique).
//
//  1. GET /api/v1/auth/config : l'emetteur et l'appli a utiliser ;
//  2. decouverte de l'emetteur (.well-known/openid-configuration) ;
//  3. beginLogin : adresse d'autorisation (state, code_challenge) ;
//  4. completeLogin : le code recu contre les jetons, puis le compte Savoire
//     (GET /api/v1/auth/me, qui le cree a la premiere connexion) ;
//  5. refresh : nouveau jeton d'acces chez l'emetteur (le jeton de
//     renouvellement tourne a chaque fois) ;
//  6. logout : revocation du jeton de renouvellement.
//
// Sans dependance : fetch et crypto.subtle (navigateur, Tauri, Node).

import { serverUrl } from './serverAddress'
import type {
  AppAuthConfig, AppAuthResponse, AppAuthUser, IAuthBackend, LoginPrompt, PendingLogin,
} from '@savoire/application'

/** Erreur du fournisseur d'identite ou du serveur, avec son statut HTTP s'il y en a un. */
export class AuthError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
    this.name = 'AuthError'
  }
}

interface Discovery {
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint?: string
  end_session_endpoint?: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  id_token?: string
}

type Fetch = typeof globalThis.fetch

function base64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomString(bytes = 32): string {
  const buf = new Uint8Array(bytes)
  globalThis.crypto.getRandomValues(buf)
  return base64Url(buf)
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

export class HttpAuthBackend implements IAuthBackend {
  // Par adresse de serveur : la version bureau change de serveur en cours de route.
  private readonly configs = new Map<string, Promise<AppAuthConfig>>()
  private readonly discoveries = new Map<string, Promise<Discovery>>()
  private readonly fetchImpl: Fetch

  /**
   * `client` : l'appli declaree chez le fournisseur ('web' : navigateur ;
   * 'desktop' : appli native, retour sur 127.0.0.1).
   */
  constructor(
    private readonly baseUrl: string = '',
    private readonly client: 'web' | 'desktop' = 'web',
    fetchImpl?: Fetch,
  ) {
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  config(): Promise<AppAuthConfig> {
    const url = serverUrl('/api/v1/auth/config', this.baseUrl)
    let p = this.configs.get(url)
    if (!p) {
      p = (async () => {
        const res = await this.fetchImpl(url)
        if (!res.ok) throw new AuthError(`${res.status} Configuration de connexion indisponible.`, res.status)
        return await res.json() as AppAuthConfig
      })()
      // Un echec (serveur injoignable) ne reste pas en cache.
      p.catch(() => this.configs.delete(url))
      this.configs.set(url, p)
    }
    return p
  }

  private discovery(issuer: string): Promise<Discovery> {
    let p = this.discoveries.get(issuer)
    if (!p) {
      p = (async () => {
        const res = await this.fetchImpl(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`)
        if (!res.ok) throw new AuthError(`${res.status} Fournisseur d'identite injoignable.`, res.status)
        return await res.json() as Discovery
      })()
      p.catch(() => this.discoveries.delete(issuer))
      this.discoveries.set(issuer, p)
    }
    return p
  }

  private async clientId(): Promise<{ config: AppAuthConfig; clientId: string }> {
    const config = await this.config()
    const clientId = this.client === 'desktop' ? config.desktopClientId : config.webClientId
    if (!clientId) throw new AuthError('Ce serveur ne declare pas d\'appli de bureau chez son fournisseur d\'identite.')
    return { config, clientId }
  }

  async beginLogin(redirectUri: string, prompt?: LoginPrompt): Promise<{ url: string; pending: PendingLogin }> {
    const { config, clientId } = await this.clientId()
    const disco = await this.discovery(config.issuer)
    const state = randomString(16)
    const codeVerifier = randomString(48)
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: config.scopes,
      state,
      code_challenge: await pkceChallenge(codeVerifier),
      code_challenge_method: 'S256',
    })
    if (prompt) params.set('prompt', prompt)
    return {
      url: `${disco.authorization_endpoint}?${params}`,
      pending: { issuer: config.issuer, clientId, redirectUri, state, codeVerifier, tokenEndpoint: disco.token_endpoint },
    }
  }

  async completeLogin(pending: PendingLogin, callback: URLSearchParams): Promise<AppAuthResponse> {
    const error = callback.get('error')
    if (error) throw new AuthError(callback.get('error_description') || error, undefined, error)
    if (callback.get('state') !== pending.state) throw new AuthError('Retour de connexion inattendu (etat different).')
    const code = callback.get('code')
    if (!code) throw new AuthError('Retour de connexion sans code.')
    const tokens = await this.token(pending.tokenEndpoint, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.codeVerifier,
    })
    return this.withUser(tokens)
  }

  async refresh(refreshToken: string): Promise<AppAuthResponse> {
    const { config, clientId } = await this.clientId()
    const disco = await this.discovery(config.issuer)
    const tokens = await this.token(disco.token_endpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    })
    return this.withUser(tokens)
  }

  async logout(_accessToken: string, refreshToken: string): Promise<void> {
    if (!refreshToken) return
    try {
      const { config, clientId } = await this.clientId()
      const disco = await this.discovery(config.issuer)
      if (!disco.revocation_endpoint) return
      await this.fetchImpl(disco.revocation_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId }),
      })
    } catch { /* meilleur effort : le jeton expirera */ }
  }

  /**
   * Adresse de fin de session chez le fournisseur (sa session a lui, sinon la
   * prochaine connexion repasse sans rien demander). Null s'il n'en a pas.
   */
  async endSessionUrl(postLogoutRedirectUri: string, idTokenHint?: string): Promise<string | null> {
    const { config, clientId } = await this.clientId()
    const disco = await this.discovery(config.issuer)
    if (!disco.end_session_endpoint) return null
    const params = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: postLogoutRedirectUri })
    if (idTokenHint) params.set('id_token_hint', idTokenHint)
    return `${disco.end_session_endpoint}?${params}`
  }

  /** Le compte Savoire du jeton (cree a la premiere connexion). */
  async me(accessToken: string): Promise<AppAuthUser> {
    const res = await this.fetchImpl(serverUrl('/api/v1/auth/me', this.baseUrl), {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new AuthError(`${res.status} Compte refuse par le serveur.`, res.status)
    return await res.json() as AppAuthUser
  }

  private async token(endpoint: string, form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    })
    if (!res.ok) {
      let code: string | undefined
      let description: string | undefined
      try {
        const body = await res.json() as { error?: string; error_description?: string }
        code = body.error
        description = body.error_description
      } catch { /* corps vide */ }
      // invalid_grant : jeton de renouvellement expire ou revoque. Statut 401 :
      // l'appli le traite comme une session finie (voir session.ts).
      const status = code === 'invalid_grant' ? 401 : res.status
      throw new AuthError(`${status} ${description || code || 'Echec de connexion.'}`, status, code)
    }
    return await res.json() as TokenResponse
  }

  private async withUser(tokens: TokenResponse): Promise<AppAuthResponse> {
    const user = await this.me(tokens.access_token)
    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? '',
      expiresIn: tokens.expires_in ?? 0,
      user,
      ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    }
  }
}
