// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Identite de service du pair chez le fournisseur d'identite (ADR-028).
import { describe, expect, it, vi } from 'vitest'
import { generateKeyPairSync, sign } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ServiceJwtVerifier, ServiceTokens, readOidcFile, serviceCallerCheck, type OidcServiceConfig,
} from '../../../../../apps/indexer/src/serviceAuth'
import { loadConfig, redacted } from '../../../../../apps/indexer/src/config'
import { tokenMatches } from '../../../../../apps/indexer/src/http'

const CFG: OidcServiceConfig = {
  issuer: 'https://auth.test',
  tokenEndpoint: 'https://auth.test/oauth/v2/token',
  jwksUri: 'https://auth.test/oauth/v2/keys',
  audience: 'project-1',
  scope: 'openid urn:zitadel:iam:org:project:id:project-1:aud',
  subject: 'indexer-sub',
  clientId: 'savoire-indexer',
  clientSecret: 'secret',
  apiSubject: 'api-sub',
}

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' }

function jwt(claims: Record<string, unknown>, kid = 'k1', key = privateKey): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' })
  const body = enc(claims)
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')
  return `${head}.${body}.${sig}`
}

const nowS = () => Math.floor(Date.now() / 1000)
const valid = (over: Record<string, unknown> = {}) =>
  jwt({ iss: CFG.issuer, aud: [CFG.audience], sub: CFG.apiSubject, exp: nowS() + 600, nbf: nowS() - 5, ...over })

function jwksFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ keys: [JWK] }), { status: 200 })) as unknown as typeof fetch
}

describe('ServiceJwtVerifier : seuls les jetons de l\'API, signes par le fournisseur', () => {
  it('accepte un jeton valide', async () => {
    expect(await new ServiceJwtVerifier(CFG, jwksFetch()).verify(valid())).toBe(true)
  })

  it.each([
    ['autre sujet (un compte de personne)', { sub: 'alice' }],
    ['autre emetteur', { iss: 'https://ailleurs.test' }],
    ['autre audience', { aud: ['autre-projet'] }],
    ['expire', { exp: nowS() - 120 }],
    ['pas encore valable', { nbf: nowS() + 600 }],
  ])('refuse : %s', async (_why, over) => {
    expect(await new ServiceJwtVerifier(CFG, jwksFetch()).verify(valid(over))).toBe(false)
  })

  it('refuse une signature d\'une autre cle, et une cle inconnue', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    const v = new ServiceJwtVerifier(CFG, jwksFetch())
    expect(await v.verify(jwt({ iss: CFG.issuer, aud: CFG.audience, sub: CFG.apiSubject, exp: nowS() + 60 }, 'k1', other))).toBe(false)
    expect(await v.verify(jwt({ iss: CFG.issuer, aud: CFG.audience, sub: CFG.apiSubject, exp: nowS() + 60 }, 'k-inconnue'))).toBe(false)
    expect(await v.verify('pas.un.jeton')).toBe(false)
  })

  it('ne relit pas les cles a chaque cle inconnue (au plus une fois par minute)', async () => {
    const f = jwksFetch()
    const v = new ServiceJwtVerifier(CFG, f)
    for (let i = 0; i < 5; i++) await v.verify(valid({}).replace(/^[^.]+/, Buffer.from(JSON.stringify({ alg: 'RS256', kid: `x${i}` })).toString('base64url')))
    expect(f).toHaveBeenCalledTimes(1)
  })
})

describe('ServiceTokens : jeton du pair vers l\'API (client credentials)', () => {
  it('demande un jeton, le garde, puis le renouvelle une minute avant la fin', async () => {
    let t = 1_000_000
    const calls: RequestInit[] = []
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls.push(init!)
      return new Response(JSON.stringify({ access_token: `at-${calls.length}`, expires_in: 300 }), { status: 200 })
    }) as unknown as typeof fetch
    const tokens = new ServiceTokens(CFG, f, () => t)
    expect(await tokens.get()).toBe('at-1')
    expect(await tokens.get()).toBe('at-1')
    t += 241_000
    expect(await tokens.get()).toBe('at-2')
    const form = new URLSearchParams(String(calls[0]!.body))
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('scope')).toBe(CFG.scope)
    expect((calls[0]!.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('savoire-indexer:secret').toString('base64')}`)
  })

  it('un jeton refuse (invalidate) est redemande', async () => {
    let n = 0
    const f = vi.fn(async () => new Response(JSON.stringify({ access_token: `at-${++n}`, expires_in: 3600 }), { status: 200 })) as unknown as typeof fetch
    const tokens = new ServiceTokens(CFG, f)
    await tokens.get()
    tokens.invalidate()
    expect(await tokens.get()).toBe('at-2')
  })
})

describe('qui peut appeler le pair', () => {
  it('le jeton partage, ou un jeton du fournisseur au nom de l\'API', async () => {
    const check = serviceCallerCheck({ token: 'shared-token-0123456789', oidc: CFG }, tokenMatches, new ServiceJwtVerifier(CFG, jwksFetch()))
    expect(await check('Bearer shared-token-0123456789')).toBe(true)
    expect(await check(`Bearer ${valid()}`)).toBe(true)
    expect(await check(`Bearer ${valid({ sub: 'alice' })}`)).toBe(false)
    expect(await check(undefined)).toBe(false)
  })

  it('sans jeton partage (fournisseur seulement), un en-tete vide ne passe pas', async () => {
    const check = serviceCallerCheck({ token: '', oidc: CFG }, tokenMatches, new ServiceJwtVerifier(CFG, jwksFetch()))
    expect(await check('Bearer ')).toBe(false)
    expect(await check('Bearer x')).toBe(false)
  })
})

describe('configuration', () => {
  it('SAVOIRE_INDEXER_OIDC_FILE rend le jeton partage facultatif ; le secret est masque', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idx-oidc-'))
    const file = join(dir, 'indexer-oidc.json')
    writeFileSync(file, JSON.stringify(CFG))
    const { config } = loadConfig({ SAVOIRE_INDEXER_NAME: 'idx-a', SAVOIRE_INDEXER_OIDC_FILE: file, SAVOIRE_INDEXER_BACKEND_URL: 'http://api:8080', SAVOIRE_INDEXER_DATA_DIR: dir })
    expect(config.token).toBe('')
    expect(config.oidc?.apiSubject).toBe('api-sub')
    expect(JSON.stringify(redacted(config))).not.toContain('"secret"')
    expect(readOidcFile(file).clientId).toBe('savoire-indexer')
  })

  it('un fichier incomplet est refuse avec les champs manquants', () => {
    const dir = mkdtempSync(join(tmpdir(), 'idx-oidc-'))
    const file = join(dir, 'bad.json')
    writeFileSync(file, JSON.stringify({ issuer: 'x' }))
    expect(() => readOidcFile(file)).toThrow(/clientSecret/)
  })
})
