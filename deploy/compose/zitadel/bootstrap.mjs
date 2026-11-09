// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Prepare Zitadel pour Savoire (ADR-028). Relance sans risque : ce qui existe
// est retrouve par son nom et mis a jour, rien n'est cree deux fois.
//
//  - un projet « Savoire » ;
//  - l'appli web (navigateur, code + PKCE, sans secret) ;
//  - l'appli de bureau (native, retour sur 127.0.0.1) ;
//  - deux comptes de service (client credentials) : le pair indexeur, et
//    l'API quand elle appelle le pair.
//
// Ecrit dans OUT_DIR :
//  - savoire-oidc.json : configuration de l'API (Auth:Oidc, Indexer:Oidc) ;
//  - indexer-oidc.json : identifiants du pair indexeur.
// Les secrets des comptes de service ne se relisent pas chez Zitadel : ils
// sont repris de ces fichiers, et recrees seulement s'ils manquent.
//
// Sans dependance : Node 22+ (fetch). Variables :
//   ZITADEL_URL     adresse jointe par le script (ex. http://zitadel:8080)
//   ZITADEL_HOST    nom public de Zitadel, envoye en Host (ex. auth.exemple.fr)
//   ZITADEL_ISSUER  emetteur public (ex. https://auth.exemple.fr)
//   ZITADEL_PAT_FILE jeton du compte machine de la premiere instance
//   WEB_ORIGINS     origines de l'appli web, separees par des virgules
//   DEV_MODE        "true" : adresses http admises (dev seulement)
//   DEFAULT_LANGUAGE langue des pages de connexion et des courriels (ex. fr)
//   OUT_DIR         dossier de sortie
//   API_FILE_OWNER, INDEXER_FILE_OWNER  "uid:gid" du lecteur de chaque fichier
//                   (production : l'utilisateur de l'image api, du pair)
//
// Connexion par un service externe (facultatif) : un fournisseur est ajoute
// des que son identifiant ET son secret sont donnes, retire s'ils disparaissent.
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
//   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT (id du
//                   tenant, ou « common » : tout compte Microsoft ; defaut)

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, chownSync } from 'node:fs'
import { dirname, join } from 'node:path'

const env = (name, fallback) => {
  const v = process.env[name]?.trim()
  if (v) return v
  if (fallback !== undefined) return fallback
  console.error(`bootstrap : ${name} manquant.`)
  process.exit(2)
}

const ZITADEL_URL = env('ZITADEL_URL').replace(/\/+$/, '')
const ZITADEL_HOST = env('ZITADEL_HOST')
const ISSUER = env('ZITADEL_ISSUER').replace(/\/+$/, '')
const PAT_FILE = env('ZITADEL_PAT_FILE')
const WEB_ORIGINS = env('WEB_ORIGINS').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
const DEV_MODE = env('DEV_MODE', 'false') === 'true'
const OUT_DIR = env('OUT_DIR')

const PROJECT = 'Savoire'
const WEB_APP = 'Savoire Web'
const DESKTOP_APP = 'Savoire Desktop'
const INDEXER_USER = 'savoire-indexer'
const API_USER = 'savoire-api'

// Le bureau revient sur une adresse locale ; le port est choisi a chaque
// connexion (RFC 8252, 7.3), Zitadel l'accepte pour une appli native.
const DESKTOP_REDIRECT = 'http://127.0.0.1/callback'

async function waitForPat() {
  for (let i = 0; i < 120; i++) {
    if (existsSync(PAT_FILE)) {
      const pat = readFileSync(PAT_FILE, 'utf8').trim()
      if (pat) return pat
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  console.error(`bootstrap : ${PAT_FILE} introuvable (premiere instance de Zitadel ?).`)
  process.exit(1)
}

const pat = await waitForPat()

async function api(method, path, body) {
  for (let attempt = 0; ; attempt++) {
    let res
    try {
      res = await fetch(ZITADEL_URL + path, {
        method,
        headers: {
          authorization: `Bearer ${pat}`,
          'content-type': 'application/json',
          // fetch ignore « Host » : Zitadel lit aussi x-zitadel-instance-host.
          'x-zitadel-instance-host': ZITADEL_HOST,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      if (attempt < 60) { await new Promise(r => setTimeout(r, 2000)); continue }
      throw err
    }
    const text = await res.text()
    if (res.status === 503 && attempt < 60) { await new Promise(r => setTimeout(r, 2000)); continue }
    if (!res.ok) {
      const err = new Error(`${method} ${path} : ${res.status} ${text}`)
      try { err.code = JSON.parse(text).code } catch { /* corps non JSON */ }
      throw err
    }
    return text ? JSON.parse(text) : {}
  }
}

const byName = name => ({ nameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } })
const byUserName = userName => ({ userNameQuery: { userName, method: 'TEXT_QUERY_METHOD_EQUALS' } })

// Une mise a jour sans effet : Zitadel repond FAILED_PRECONDITION (code 9),
// avec un message traduit dans la langue de l'instance.
const isNoChange = err => err?.code === 9

// ── Projet ──────────────────────────────────────────────────────────────────
async function ensureProject() {
  const found = await api('POST', '/management/v1/projects/_search', { queries: [byName(PROJECT)] })
  const existing = (found.result ?? []).find(p => p.name === PROJECT)
  if (existing) return existing.id
  const created = await api('POST', '/management/v1/projects', { name: PROJECT })
  console.log(`projet ${PROJECT} cree`)
  return created.id
}

// ── Applis OIDC ─────────────────────────────────────────────────────────────
async function ensureOidcApp(projectId, name, config) {
  const found = await api('POST', `/management/v1/projects/${projectId}/apps/_search`, {})
  const existing = (found.result ?? []).find(a => a.name === name)
  if (existing) {
    try {
      await api('PUT', `/management/v1/projects/${projectId}/apps/${existing.id}/oidc_config`, config)
    } catch (err) {
      if (!isNoChange(err)) throw err
    }
    return existing.oidcConfig.clientId
  }
  const created = await api('POST', `/management/v1/projects/${projectId}/apps/oidc`, { name, ...config })
  console.log(`appli ${name} creee`)
  return created.clientId
}

const common = {
  responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
  grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
  authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
  // Jeton d'acces signe (JWT) : l'API le verifie seule, par les cles publiees (JWKS).
  accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
  accessTokenRoleAssertion: false,
  idTokenRoleAssertion: false,
  idTokenUserinfoAssertion: true,
  clockSkew: '0s',
}

// ── Comptes de service ──────────────────────────────────────────────────────
// `previous` : { Subject, ClientId, ClientSecret } deja ecrit, repris tel quel.
async function ensureMachine(userName, name, previous) {
  const found = await api('POST', '/management/v1/users/_search', { queries: [byUserName(userName)] })
  let user = (found.result ?? []).find(u => u.userName === userName)
  if (!user) {
    const created = await api('POST', '/management/v1/users/machine', {
      userName, name, description: `${name} (Savoire)`, accessTokenType: 'ACCESS_TOKEN_TYPE_JWT',
    })
    user = { id: created.userId }
    console.log(`compte de service ${userName} cree`)
  }
  if (previous?.Subject === user.id && previous.ClientId && previous.ClientSecret) return previous
  const secret = await api('PUT', `/management/v1/users/${user.id}/secret`, {})
  return { Subject: user.id, ClientId: secret.clientId, ClientSecret: secret.clientSecret }
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

// Des secrets : lisibles par leur seul lecteur. En dev, par tous (poste local).
function writeJson(path, value, owner) {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: DEV_MODE ? 0o644 : 0o600 })
  if (owner) {
    const [uid, gid] = owner.split(':').map(Number)
    chownSync(tmp, uid, Number.isInteger(gid) ? gid : uid)
  }
  renameSync(tmp, path)
}

mkdirSync(OUT_DIR, { recursive: true })
const apiFile = join(OUT_DIR, 'savoire-oidc.json')
const indexerFile = join(OUT_DIR, 'indexer-oidc.json')
const previousApi = readJson(apiFile)
const previousIndexer = readJson(indexerFile)

const projectId = await ensureProject()

// Langue par defaut des pages de connexion et des courriels.
const language = process.env.DEFAULT_LANGUAGE?.trim()
if (language) {
  try {
    await api('PUT', `/admin/v1/languages/default/${encodeURIComponent(language)}`, {})
  } catch (err) {
    if (!isNoChange(err)) throw err
  }
}

// ── Marque des pages de connexion ─────────────────────────────────────────
// Couleurs reprises du theme d'Obsidian (violet d'accent, fonds neutres),
// logo de Savoire, sans le filigrane ni le suffixe de domaine du nom.
const BRANDING = {
  primaryColor: '#7f6df2',
  backgroundColor: '#ffffff',
  warnColor: '#e93147',
  fontColor: '#222222',
  primaryColorDark: '#8a7cf7',
  backgroundColorDark: '#1e1e1e',
  warnColorDark: '#fb464c',
  fontColorDark: '#dadada',
  hideLoginNameSuffix: true,
  disableWatermark: true,
}
const BRANDING_DIR = env('BRANDING_DIR', join(dirname(new URL(import.meta.url).pathname), 'branding'))

async function uploadAsset(path, file) {
  const full = join(BRANDING_DIR, file)
  if (!existsSync(full)) return
  const form = new FormData()
  form.append('file', new Blob([readFileSync(full)], { type: 'image/svg+xml' }), file)
  const res = await fetch(ZITADEL_URL + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${pat}`, 'x-zitadel-instance-host': ZITADEL_HOST },
    body: form,
  })
  if (!res.ok) throw new Error(`POST ${path} : ${res.status} ${await res.text()}`)
}

async function ensureBranding() {
  try {
    await api('PUT', '/admin/v1/policies/label', BRANDING)
  } catch (err) {
    if (!isNoChange(err)) throw err
  }
  await uploadAsset('/assets/v1/instance/policy/label/logo', 'logo.svg')
  await uploadAsset('/assets/v1/instance/policy/label/logo/dark', 'logo-dark.svg')
  await uploadAsset('/assets/v1/instance/policy/label/icon', 'icon.svg')
  await uploadAsset('/assets/v1/instance/policy/label/icon/dark', 'icon-dark.svg')
  // Les changements de marque restent en brouillon tant qu'on ne les active pas.
  await api('POST', '/admin/v1/policies/label/_activate', {})
}

try {
  await ensureBranding()
} catch (err) {
  // Une marque refusee ne doit pas empecher la connexion de marcher.
  console.error(`bootstrap : marque des pages de connexion non appliquee (${err.message}).`)
}

// ── Connexion par Google, GitHub, Microsoft ────────────────────────────────
// Fournisseurs de l'instance : la personne choisit « Continuer avec Google »
// sur la page de connexion ; un compte Savoire est cree a la premiere venue,
// relie ensuite. Les noms servent de cle : relancer met a jour, sans doublon.
const PROVIDER_OPTIONS = { isLinkingAllowed: true, isCreationAllowed: true, isAutoCreation: true, isAutoUpdate: true }
const MS_TENANTS = { common: 'AZURE_AD_TENANT_TYPE_COMMON', organizations: 'AZURE_AD_TENANT_TYPE_ORGANISATIONS', consumers: 'AZURE_AD_TENANT_TYPE_CONSUMERS' }
const EXTERNAL_IDPS = [
  {
    name: 'Google', kind: 'google', id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET',
    body: () => ({ scopes: ['openid', 'profile', 'email'] }),
  },
  {
    name: 'GitHub', kind: 'github', id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET',
    body: () => ({ scopes: ['read:user', 'user:email'] }),
  },
  {
    name: 'Microsoft', kind: 'azure', id: 'MICROSOFT_CLIENT_ID', secret: 'MICROSOFT_CLIENT_SECRET',
    body: () => {
      const tenant = process.env.MICROSOFT_TENANT?.trim() || 'common'
      return {
        tenant: MS_TENANTS[tenant] ? { tenantType: MS_TENANTS[tenant] } : { tenantId: tenant },
        emailVerified: true,
        scopes: ['openid', 'profile', 'email', 'User.Read'],
      }
    },
  },
]

async function findIdp(name) {
  const found = await api('POST', '/admin/v1/idps/templates/_search', {
    queries: [{ idpNameQuery: { name, method: 'TEXT_QUERY_METHOD_EQUALS' } }],
  })
  return found.result?.[0]
}

async function ensureExternalIdps() {
  const enabled = []
  for (const idp of EXTERNAL_IDPS) {
    const clientId = process.env[idp.id]?.trim()
    const clientSecret = process.env[idp.secret]?.trim()
    const existing = await findIdp(idp.name)
    if (!clientId || !clientSecret) {
      if (existing) {
        // Plus d'identifiants : le bouton disparait de la page de connexion.
        await api('DELETE', `/admin/v1/policies/login/idps/${existing.id}`).catch(() => {})
        await api('DELETE', `/admin/v1/idps/templates/${existing.id}`)
        console.log(`bootstrap : connexion ${idp.name} retiree.`)
      }
      continue
    }
    const body = { name: idp.name, clientId, clientSecret, providerOptions: PROVIDER_OPTIONS, ...idp.body() }
    let id = existing?.id
    if (id) {
      try { await api('PUT', `/admin/v1/idps/${idp.kind}/${id}`, body) } catch (err) { if (!isNoChange(err)) throw err }
    } else {
      id = (await api('POST', `/admin/v1/idps/${idp.kind}`, body)).id
    }
    try { await api('POST', '/admin/v1/policies/login/idps', { idpId: id }) } catch (err) {
      // Deja dans la politique de connexion : rien a faire.
      if (err.code !== 6 && !isNoChange(err)) throw err
    }
    enabled.push(idp.name)
  }
  if (enabled.length) {
    // Les fournisseurs externes doivent etre permis par la politique de connexion.
    const { policy } = await api('GET', '/admin/v1/policies/login')
    if (!policy.allowExternalIdp) {
      const { details, isDefault, idps, ...fields } = policy
      try { await api('PUT', '/admin/v1/policies/login', { ...fields, allowExternalIdp: true }) } catch (err) { if (!isNoChange(err)) throw err }
    }
    console.log(`bootstrap : connexion par ${enabled.join(', ')} active.`)
    console.log(`bootstrap : adresse de retour a declarer chez chaque fournisseur : ${ISSUER}/idps/callback`)
  }
}

try {
  await ensureExternalIdps()
} catch (err) {
  // Un fournisseur refuse ne doit pas empecher la connexion par mot de passe.
  console.error(`bootstrap : connexion externe non configuree (${err.message}).`)
}

const webClientId = await ensureOidcApp(projectId, WEB_APP, {
  ...common,
  appType: 'OIDC_APP_TYPE_USER_AGENT',
  redirectUris: WEB_ORIGINS.map(o => `${o}/auth/callback`),
  postLogoutRedirectUris: WEB_ORIGINS.map(o => `${o}/`),
  devMode: DEV_MODE,
})

const desktopClientId = await ensureOidcApp(projectId, DESKTOP_APP, {
  ...common,
  appType: 'OIDC_APP_TYPE_NATIVE',
  redirectUris: [DESKTOP_REDIRECT],
  postLogoutRedirectUris: [],
  // Une appli native revient sur http://127.0.0.1 (port libre) : admis sans
  // le mode dev (verifie avec Zitadel v4.16).
  devMode: false,
})

const indexer = await ensureMachine(INDEXER_USER, 'Pair indexeur', previousIndexer && {
  Subject: previousIndexer.subject, ClientId: previousIndexer.clientId, ClientSecret: previousIndexer.clientSecret,
})
const apiService = await ensureMachine(API_USER, 'API Savoire', previousApi?.Indexer?.Oidc)

// Audience des jetons de service : le projet (porte « aud » = projet).
const serviceScope = `openid urn:zitadel:iam:org:project:id:${projectId}:aud`

writeJson(apiFile, {
  Auth: {
    Oidc: {
      Authority: ISSUER,
      Audience: projectId,
      WebClientId: webClientId,
      DesktopClientId: desktopClientId,
      RequireHttpsMetadata: !DEV_MODE,
    },
  },
  Indexer: {
    Oidc: {
      // Le pair indexeur, tel que l'API le reconnait (sujet de ses jetons).
      PeerSubject: indexer.Subject,
      // L'API, quand elle appelle le pair.
      Subject: apiService.Subject,
      ClientId: apiService.ClientId,
      ClientSecret: apiService.ClientSecret,
      TokenEndpoint: `${ISSUER}/oauth/v2/token`,
      Scope: serviceScope,
    },
  },
}, process.env.API_FILE_OWNER?.trim())

writeJson(indexerFile, {
  issuer: ISSUER,
  tokenEndpoint: `${ISSUER}/oauth/v2/token`,
  jwksUri: `${ISSUER}/oauth/v2/keys`,
  audience: projectId,
  scope: serviceScope,
  subject: indexer.Subject,
  clientId: indexer.ClientId,
  clientSecret: indexer.ClientSecret,
  // Le seul appelant admis par le pair : l'API.
  apiSubject: apiService.Subject,
}, process.env.INDEXER_FILE_OWNER?.trim())

// Dev seulement : les jetons d'administration a cote, pour les tests et les
// scripts du poste (comptes de test, connexion sans navigateur).
if (DEV_MODE) {
  for (const [from, to] of [[PAT_FILE, 'dev-admin.pat'], [join(dirname(PAT_FILE), 'login-client.pat'), 'dev-login.pat']]) {
    if (existsSync(from)) writeFileSync(join(OUT_DIR, to), readFileSync(from), { mode: 0o644 })
  }
}

console.log(`Zitadel pret : projet ${projectId}, web ${webClientId}, bureau ${desktopClientId}.`)
