// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Identite de service du pair indexeur chez le fournisseur d'identite
// (ADR-028), a la place du jeton partage avec l'API :
//
//  - vers l'API : un jeton « client credentials » du compte de service
//    savoire-indexer, garde jusqu'a une minute avant son expiration ;
//  - depuis l'API : un jeton signe par le fournisseur (RS256, cles publiees
//    en JWKS), d'emetteur et d'audience attendus, dont le sujet est le compte
//    de service savoire-api. Aucun autre appelant n'est admis.
//
// Le fichier SAVOIRE_INDEXER_OIDC_FILE (ecrit par deploy/compose/zitadel/
// bootstrap.mjs) donne ces valeurs. Sans dependance : node:crypto et fetch.

import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'

export interface OidcServiceConfig {
  issuer: string
  tokenEndpoint: string
  jwksUri: string
  /** Audience attendue (l'id du projet Savoire chez le fournisseur). */
  audience: string
  scope: string
  /** Le pair : son compte de service. */
  subject: string
  clientId: string
  clientSecret: string
  /** Le seul appelant admis : le compte de service de l'API. */
  apiSubject: string
}

const FIELDS: (keyof OidcServiceConfig)[] = ['issuer', 'tokenEndpoint', 'jwksUri', 'audience', 'scope', 'subject', 'clientId', 'clientSecret', 'apiSubject']

/** Lit et verifie le fichier ; leve une erreur lisible. */
export function readOidcFile(path: string): OidcServiceConfig {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`lecture impossible de ${path} (${(err as Error).message})`)
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const missing = FIELDS.filter(f => typeof o[f] !== 'string' || !(o[f] as string).trim())
  if (missing.length) throw new Error(`${path} : champs manquants (${missing.join(', ')})`)
  return Object.fromEntries(FIELDS.map(f => [f, (o[f] as string).trim()])) as unknown as OidcServiceConfig
}

type Fetch = typeof globalThis.fetch

/** Jeton du pair vers l'API (client credentials), renouvele avant expiration. */
export class ServiceTokens {
  private current: { token: string; renewAt: number } | null = null
  private pending: Promise<string> | null = null

  constructor(
    private readonly cfg: OidcServiceConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
  ) {}

  get(): Promise<string> {
    if (this.current && this.now() < this.current.renewAt) return Promise.resolve(this.current.token)
    this.pending ??= this.fetchToken().finally(() => { this.pending = null })
    return this.pending
  }

  /** Jeton refuse (401) : le prochain appel en demande un neuf. */
  invalidate(): void {
    this.current = null
  }

  private async fetchToken(): Promise<string> {
    const basic = Buffer.from(`${encodeURIComponent(this.cfg.clientId)}:${encodeURIComponent(this.cfg.clientSecret)}`).toString('base64')
    const res = await this.fetchImpl(this.cfg.tokenEndpoint, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: this.cfg.scope }),
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`fournisseur d'identite : jeton de service refuse (${res.status}) ${text.slice(0, 200)}`)
    const body = JSON.parse(text) as { access_token?: string; expires_in?: number }
    if (!body.access_token) throw new Error('fournisseur d\'identite : reponse sans jeton')
    const lifetimeMs = Math.max(60_000, (body.expires_in ?? 300) * 1000)
    this.current = { token: body.access_token, renewAt: this.now() + lifetimeMs - 60_000 }
    return body.access_token
  }
}

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
}

/** Verifie les jetons de l'API (RS256, JWKS du fournisseur). */
export class ServiceJwtVerifier {
  private keys = new Map<string, KeyObject>()
  private lastFetch = 0
  private pending: Promise<void> | null = null

  constructor(
    private readonly cfg: OidcServiceConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch.bind(globalThis),
    private readonly now: () => number = Date.now,
  ) {}

  /** Vrai si le jeton vient du fournisseur, pour ce projet, et du compte de l'API. */
  async verify(token: string): Promise<boolean> {
    const parts = token.split('.')
    if (parts.length !== 3) return false
    let header: Record<string, unknown>
    let claims: Record<string, unknown>
    try {
      header = b64urlJson(parts[0]!)
      claims = b64urlJson(parts[1]!)
    } catch {
      return false
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return false
    const key = await this.key(header.kid)
    if (!key) return false
    const signed = verifySignature('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))
    if (!signed) return false

    const nowS = this.now() / 1000
    const skew = 30
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    return claims.iss === this.cfg.issuer
      && aud.includes(this.cfg.audience)
      && claims.sub === this.cfg.apiSubject
      && typeof claims.exp === 'number' && claims.exp + skew > nowS
      && (typeof claims.nbf !== 'number' || claims.nbf - skew <= nowS)
  }

  /** Cle d'id `kid` ; une cle inconnue relit les cles (au plus une fois par minute). */
  private async key(kid: string): Promise<KeyObject | undefined> {
    if (!this.keys.has(kid) && this.now() - this.lastFetch > 60_000) {
      this.pending ??= this.fetchKeys().finally(() => { this.pending = null })
      try { await this.pending } catch { /* fournisseur injoignable : cles connues seulement */ }
    }
    return this.keys.get(kid)
  }

  private async fetchKeys(): Promise<void> {
    this.lastFetch = this.now()
    const res = await this.fetchImpl(this.cfg.jwksUri, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`JWKS ${res.status}`)
    const body = await res.json() as { keys?: (JsonWebKey & { kid?: string; use?: string })[] }
    const next = new Map<string, KeyObject>()
    for (const jwk of body.keys ?? []) {
      if (!jwk.kid || jwk.kty !== 'RSA' || (jwk.use && jwk.use !== 'sig')) continue
      try { next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' })) } catch { /* cle illisible */ }
    }
    this.keys = next
  }
}

/** Le jeton a presenter au backend : celui du fournisseur, sinon le jeton partage. */
export function bearerSourceFor(c: { token: string; oidc?: OidcServiceConfig }): { get(): Promise<string>; invalidate?(): void } {
  if (c.oidc) return new ServiceTokens(c.oidc)
  return { get: () => Promise.resolve(c.token) }
}

/**
 * Qui peut appeler le pair : le jeton partage (s'il y en a un), ou un jeton du
 * fournisseur au nom de l'API (si le pair a son identite de service).
 */
export function serviceCallerCheck(
  c: { token: string; oidc?: OidcServiceConfig },
  tokenMatches: (header: string | undefined, expected: string) => boolean,
  verifier: ServiceJwtVerifier | null = c.oidc ? new ServiceJwtVerifier(c.oidc) : null,
): (header: string | undefined) => Promise<boolean> {
  return async header => {
    if (c.token && tokenMatches(header, c.token)) return true
    if (!verifier) return false
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
    return !!m && await verifier.verify(m[1]!)
  }
}
