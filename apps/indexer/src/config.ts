// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Configuration du pair indexeur : variables d'environnement SAVOIRE_INDEXER_*,
// toutes decrites ici (nom, defaut, bornes, role). La table sert aussi a
// `--help` et au README. Tout est verifie au demarrage : une valeur fausse
// arrete le service avec la liste des erreurs, plutot qu'un comportement
// surprenant plus tard. Une variable SAVOIRE_INDEXER_* inconnue (faute de
// frappe) est signalee.
import { readOidcFile, type OidcServiceConfig } from './serviceAuth'
import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { resolve } from 'node:path'
import type { LogLevel } from './log'

type Kind = 'string' | 'secret' | 'url' | 'int' | 'duration' | 'bytes' | 'enum' | 'path'

interface Setting {
  key: keyof IndexerConfig
  env: string
  kind: Kind
  /** Valeur par defaut (texte, comme dans l'environnement) ; absente : obligatoire. */
  def?: string | (() => string)
  min?: number
  max?: number
  values?: readonly string[]
  doc: string
}

export interface IndexerConfig {
  name: string
  /** Jeton partage avec le backend ; vide si l'identite vient du fournisseur (oidc). */
  token: string
  /** Identite de service chez le fournisseur d'identite (SAVOIRE_INDEXER_OIDC_FILE, ADR-028). */
  oidc?: OidcServiceConfig
  backendUrl: string
  dataDir: string
  host: string
  port: number
  workers: number
  maxOpen: number
  sqliteCacheKiB: number
  debounceMs: number
  debounceMaxMs: number
  orphanTtlMs: number
  buildConcurrency: number
  buildBatch: number
  fetchConcurrency: number
  feedLimit: number
  feedActiveMs: number
  feedIdleMs: number
  feedStaleMs: number
  vaultsRefreshMs: number
  backendTimeoutMs: number
  backendRetries: number
  maxDocBytes: number
  callTimeoutMs: number
  maxQueue: number
  retryAfterS: number
  unavailableRetryAfterS: number
  maxBodyBytes: number
  searchMaxVaults: number
  searchParallelism: number
  cacheEntries: number
  cacheMaxBytes: number
  cacheTtlMs: number
  lagWarnMs: number
  statsIntervalMs: number
  metricsAuth: 'token' | 'none'
  extractFiles: 'on' | 'off'
  ocr: 'on' | 'off'
  metricsMaxVaults: number
  slowCallMs: number
  shutdownTimeoutMs: number
  logLevel: LogLevel
  errorDsn: string
  errorEnvironment: string
}

const defaultWorkers = () => String(Math.max(1, Math.min(4, availableParallelism() - 1)))

export const SETTINGS: readonly Setting[] = [
  { key: 'name', env: 'SAVOIRE_INDEXER_NAME', kind: 'string', doc: 'Nom de cette instance, tel qu\'il figure dans `Indexer:Instances` du backend. Obligatoire.' },
  { key: 'token', env: 'SAVOIRE_INDEXER_TOKEN', kind: 'secret', doc: 'Jeton de service partage avec le backend (`Indexer:ServiceToken`), 16 caracteres au moins. Obligatoire, sauf `SAVOIRE_INDEXER_TOKEN_FILE` ou `SAVOIRE_INDEXER_OIDC_FILE` (identite chez le fournisseur d\'identite, ADR-028).' },
  { key: 'backendUrl', env: 'SAVOIRE_INDEXER_BACKEND_URL', kind: 'url', doc: 'Adresse du backend sur le reseau prive (API interne `/internal/indexer`). Obligatoire.' },
  { key: 'dataDir', env: 'SAVOIRE_INDEXER_DATA_DIR', kind: 'path', def: './data', doc: 'Dossier des index : un `{vaultId}.sqlite` par vault, plus l\'etat du flux. SSD local (jamais un partage SMB/NFS).' },
  { key: 'host', env: 'SAVOIRE_INDEXER_HOST', kind: 'string', def: '0.0.0.0', doc: 'Adresse d\'ecoute.' },
  { key: 'port', env: 'SAVOIRE_INDEXER_PORT', kind: 'int', def: '7070', min: 0, max: 65535, doc: 'Port d\'ecoute (0 : choisi par le systeme).' },
  { key: 'workers', env: 'SAVOIRE_INDEXER_WORKERS', kind: 'int', def: defaultWorkers, min: 0, max: 64, doc: 'Fils d\'execution qui portent les index (un vault = un fil, donc un seul ecrivain). 0 : tout dans le fil principal. Defaut : coeurs - 1, entre 1 et 4.' },
  { key: 'maxOpen', env: 'SAVOIRE_INDEXER_MAX_OPEN', kind: 'int', def: '128', min: 1, max: 100000, doc: 'Fichiers SQLite ouverts a la fois (toute l\'instance) ; au-dela, les moins recemment utilises sont fermes.' },
  { key: 'sqliteCacheKiB', env: 'SAVOIRE_INDEXER_SQLITE_CACHE_KIB', kind: 'int', def: '2048', min: 64, max: 1048576, doc: 'Cache de pages SQLite par fichier ouvert (Kio). Memoire au pire : MAX_OPEN x cette valeur.' },
  { key: 'debounceMs', env: 'SAVOIRE_INDEXER_DEBOUNCE_MS', kind: 'duration', def: '1000', min: 0, max: 600000, doc: 'Regroupement des changements d\'une note : relue quand elle n\'a plus change depuis ce delai.' },
  { key: 'debounceMaxMs', env: 'SAVOIRE_INDEXER_DEBOUNCE_MAX_MS', kind: 'duration', def: '5000', min: 0, max: 3600000, doc: 'Attente maximale d\'une note qui change sans arret (frappe continue).' },
  { key: 'orphanTtlMs', env: 'SAVOIRE_INDEXER_ORPHAN_TTL', kind: 'duration', def: '24h', min: 0, max: 365 * 86400000, doc: 'Delai avant de supprimer l\'index d\'un vault qui n\'appartient plus a cette instance (`30s`, `15m`, `24h`, `7d` ou des ms).' },
  { key: 'buildConcurrency', env: 'SAVOIRE_INDEXER_BUILD_CONCURRENCY', kind: 'int', def: '2', min: 1, max: 64, doc: 'Vaults construits en meme temps (toute l\'instance). Les constructions passent apres les appels et les mises a jour.' },
  { key: 'buildBatch', env: 'SAVOIRE_INDEXER_BUILD_BATCH', kind: 'int', def: '50', min: 1, max: 5000, doc: 'Notes ecrites par transaction pendant une construction (plus petit : appels moins retardes).' },
  { key: 'fetchConcurrency', env: 'SAVOIRE_INDEXER_FETCH_CONCURRENCY', kind: 'int', def: '8', min: 1, max: 256, doc: 'Lectures de documents en parallele vers le backend, par fil.' },
  { key: 'feedLimit', env: 'SAVOIRE_INDEXER_FEED_LIMIT', kind: 'int', def: '500', min: 1, max: 2000, doc: 'Changements demandes par appel au flux (2 000 pendant un rattrapage).' },
  { key: 'feedActiveMs', env: 'SAVOIRE_INDEXER_FEED_ACTIVE_MS', kind: 'duration', def: '100', min: 0, max: 60000, doc: 'Cadence du flux quand il bouge.' },
  { key: 'feedIdleMs', env: 'SAVOIRE_INDEXER_FEED_IDLE_MS', kind: 'duration', def: '500', min: 10, max: 600000, doc: 'Cadence du flux au repos (la cadence ralentit jusqu\'a cette valeur). Avec DEBOUNCE, borne le delai d\'indexation.' },
  { key: 'feedStaleMs', env: 'SAVOIRE_INDEXER_FEED_STALE_MS', kind: 'duration', def: '30000', min: 100, max: 3600000, doc: 'Sans reponse du flux depuis ce delai : `ready` faux, index rendus « en retard ».' },
  { key: 'vaultsRefreshMs', env: 'SAVOIRE_INDEXER_VAULTS_REFRESH_MS', kind: 'duration', def: '60000', min: 100, max: 86400000, doc: 'Relecture de la liste des vaults de l\'instance (changement de repartition, orphelins).' },
  { key: 'backendTimeoutMs', env: 'SAVOIRE_INDEXER_BACKEND_TIMEOUT_MS', kind: 'duration', def: '15000', min: 100, max: 600000, doc: 'Delai maximal d\'un appel au backend.' },
  { key: 'backendRetries', env: 'SAVOIRE_INDEXER_BACKEND_RETRIES', kind: 'int', def: '3', min: 0, max: 20, doc: 'Nouveaux essais d\'une lecture qui echoue (reseau, 5xx), avec attente croissante.' },
  { key: 'maxDocBytes', env: 'SAVOIRE_INDEXER_MAX_DOC_BYTES', kind: 'bytes', def: '32MiB', min: 1024, max: 2 ** 31, doc: 'Taille maximale d\'une reponse du backend (journal d\'un document ou de l\'arbre) ; au-dela, le document est ignore et signale.' },
  { key: 'callTimeoutMs', env: 'SAVOIRE_INDEXER_CALL_TIMEOUT_MS', kind: 'duration', def: '4000', min: 50, max: 600000, doc: 'Delai maximal d\'un appel (attente comprise) ; au-dela, 503. Garder sous `Indexer:TimeoutMs` du backend (5 s).' },
  { key: 'maxQueue', env: 'SAVOIRE_INDEXER_MAX_QUEUE', kind: 'int', def: '256', min: 1, max: 100000, doc: 'Appels en cours ou en attente (toute l\'instance) ; au-dela, 429 `overloaded`.' },
  { key: 'retryAfterS', env: 'SAVOIRE_INDEXER_RETRY_AFTER_S', kind: 'int', def: '1', min: 1, max: 3600, doc: '`Retry-After` d\'un 429.' },
  { key: 'unavailableRetryAfterS', env: 'SAVOIRE_INDEXER_UNAVAILABLE_RETRY_AFTER_S', kind: 'int', def: '5', min: 1, max: 3600, doc: '`Retry-After` d\'un 503.' },
  { key: 'maxBodyBytes', env: 'SAVOIRE_INDEXER_MAX_BODY_BYTES', kind: 'bytes', def: '256KiB', min: 1024, max: 64 * 1024 * 1024, doc: 'Taille maximale d\'un corps de requete ; au-dela, 413.' },
  { key: 'searchMaxVaults', env: 'SAVOIRE_INDEXER_SEARCH_MAX_VAULTS', kind: 'int', def: '1000', min: 1, max: 100000, doc: 'Vaults d\'une recherche globale, au plus ; au-dela, 400 `too_complex`.' },
  { key: 'searchParallelism', env: 'SAVOIRE_INDEXER_SEARCH_PARALLELISM', kind: 'int', def: '8', min: 1, max: 1024, doc: 'Recherche globale : vaults interroges en meme temps.' },
  { key: 'cacheEntries', env: 'SAVOIRE_INDEXER_CACHE_ENTRIES', kind: 'int', def: '2000', min: 0, max: 10000000, doc: 'Resultats gardes en cache (0 : pas de cache). Une entree ne sert que tant que l\'index du vault n\'a pas bouge.' },
  { key: 'cacheMaxBytes', env: 'SAVOIRE_INDEXER_CACHE_MAX_BYTES', kind: 'bytes', def: '64MiB', min: 0, max: 2 ** 34, doc: 'Taille maximale du cache de resultats.' },
  { key: 'cacheTtlMs', env: 'SAVOIRE_INDEXER_CACHE_TTL_MS', kind: 'duration', def: '10000', min: 0, max: 3600000, doc: 'Duree de vie d\'un resultat en cache.' },
  { key: 'lagWarnMs', env: 'SAVOIRE_INDEXER_LAG_WARN_MS', kind: 'duration', def: '5000', min: 0, max: 3600000, doc: 'Retard au-dela duquel un index est rendu `lagging` (avec `lagMs`).' },
  { key: 'statsIntervalMs', env: 'SAVOIRE_INDEXER_STATS_INTERVAL_MS', kind: 'duration', def: '30000', min: 1000, max: 3600000, doc: 'Rafraichissement des tailles et nombres de notes par vault (metriques).' },
  { key: 'extractFiles', env: 'SAVOIRE_INDEXER_EXTRACT_FILES', kind: 'enum', def: 'on', values: ['on', 'off'], doc: 'Lire le texte des fichiers (PDF, Word, Excel, PowerPoint, LibreOffice, pages web, CSV, images) par les extracteurs des plugins officiels.' },
  { key: 'ocr', env: 'SAVOIRE_INDEXER_OCR', kind: 'enum', def: 'on', values: ['on', 'off'], doc: 'Lire le texte dans les images (OCR, quelques secondes par image ; langues gardees dans `{dataDir}/ocr`).' },
  { key: 'metricsAuth', env: 'SAVOIRE_INDEXER_METRICS_AUTH', kind: 'enum', def: 'token', values: ['token', 'none'], doc: '`/metrics` demande le jeton de service (`token`) ou non (`none`, reseau prive seulement).' },
  { key: 'metricsMaxVaults', env: 'SAVOIRE_INDEXER_METRICS_MAX_VAULTS', kind: 'int', def: '1000', min: 0, max: 1000000, doc: 'Vaults detailles dans `/metrics` (les plus gros, en retard ou en construction d\'abord) ; 0 : aucun.' },
  { key: 'slowCallMs', env: 'SAVOIRE_INDEXER_SLOW_CALL_MS', kind: 'duration', def: '1000', min: 0, max: 600000, doc: 'Appel journalise en avertissement au-dela de cette duree.' },
  { key: 'shutdownTimeoutMs', env: 'SAVOIRE_INDEXER_SHUTDOWN_TIMEOUT_MS', kind: 'duration', def: '15000', min: 100, max: 600000, doc: 'Arret propre (SIGTERM) : attente maximale des appels et ecritures en cours.' },
  { key: 'logLevel', env: 'SAVOIRE_INDEXER_LOG_LEVEL', kind: 'enum', def: 'info', values: ['debug', 'info', 'warn', 'error', 'silent'], doc: 'Niveau du journal (JSON, une ligne par evenement).' },
  { key: 'errorDsn', env: 'SAVOIRE_INDEXER_ERROR_DSN', kind: 'string', def: '', doc: 'Suivi des erreurs : DSN d\'un projet GlitchTip (ou Sentry). Chaque ligne de journal `error` y est aussi envoyee. Vide : rien n\'est envoye.' },
  { key: 'errorEnvironment', env: 'SAVOIRE_INDEXER_ERROR_ENVIRONMENT', kind: 'string', def: 'production', doc: 'Environnement annonce dans les rapports d\'erreur.' },
]

/** Variables lues sans etre dans la table. */
const EXTRA_ENV = new Set(['SAVOIRE_INDEXER_TOKEN_FILE', 'SAVOIRE_INDEXER_OIDC_FILE', 'SAVOIRE_INDEXER_ERROR_DSN_FILE'])

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
const BYTES = /^(\d+(?:\.\d+)?)\s*(b|kib|kb|k|mib|mb|m|gib|gb|g)?$/i
const UNIT_B: Record<string, number> = {
  b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3,
}

export function parseDuration(text: string): number | undefined {
  const m = DURATION.exec(text.trim())
  if (!m) return undefined
  return Math.round(Number(m[1]) * UNIT_MS[(m[2] ?? 'ms').toLowerCase()]!)
}

export function parseBytes(text: string): number | undefined {
  const m = BYTES.exec(text.trim())
  if (!m) return undefined
  return Math.round(Number(m[1]) * UNIT_B[(m[2] ?? 'b').toLowerCase()]!)
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Configuration invalide :\n - ${problems.join('\n - ')}`)
    this.name = 'ConfigError'
  }
}

export interface LoadedConfig {
  config: IndexerConfig
  /** Avertissements (variables inconnues...). */
  warnings: string[]
}

/** Lit et verifie la configuration. Leve ConfigError avec toutes les erreurs. */
export function loadConfig(env: Record<string, string | undefined> = process.env): LoadedConfig {
  const problems: string[] = []
  const warnings: string[] = []
  const out: Record<string, unknown> = {}

  let tokenFromFile: string | undefined
  const tokenFile = env['SAVOIRE_INDEXER_TOKEN_FILE']?.trim()
  if (tokenFile) {
    try {
      tokenFromFile = readFileSync(tokenFile, 'utf8').trim()
    } catch (err) {
      problems.push(`SAVOIRE_INDEXER_TOKEN_FILE : lecture impossible de ${tokenFile} (${(err as Error).message}).`)
    }
  }

  // Identite de service chez le fournisseur d'identite (ADR-028) : le jeton
  // partage devient facultatif.
  let oidc: OidcServiceConfig | undefined
  const oidcFile = env['SAVOIRE_INDEXER_OIDC_FILE']?.trim()
  if (oidcFile) {
    try {
      oidc = readOidcFile(oidcFile)
    } catch (err) {
      problems.push(`SAVOIRE_INDEXER_OIDC_FILE : ${(err as Error).message}.`)
    }
  }

  // DSN du suivi des erreurs ecrit par deploy/compose/glitchtip/bootstrap.py.
  // Fichier absent ou illisible : pas de suivi, jamais une erreur.
  let errorDsnFromFile: string | undefined
  const errorDsnFile = env['SAVOIRE_INDEXER_ERROR_DSN_FILE']?.trim()
  if (errorDsnFile) {
    try { errorDsnFromFile = readFileSync(errorDsnFile, 'utf8').trim() || undefined } catch { /* rien */ }
  }

  for (const s of SETTINGS) {
    let raw = env[s.env]
    if (s.key === 'errorDsn' && (raw === undefined || raw === '') && errorDsnFromFile !== undefined) raw = errorDsnFromFile
    if (s.key === 'token' && (raw === undefined || raw === '') && tokenFromFile !== undefined) raw = tokenFromFile
    if (s.key === 'token' && (raw === undefined || raw === '') && oidcFile) { out.token = ''; continue }
    if (raw === undefined || raw.trim() === '') {
      if (s.def === undefined) { problems.push(`${s.env} : obligatoire. ${s.doc}`); continue }
      raw = typeof s.def === 'function' ? s.def() : s.def
    }
    const text = s.kind === 'secret' ? raw : raw.trim()
    const range = (n: number, unit = '') => {
      if (s.min !== undefined && n < s.min) problems.push(`${s.env} : ${n}${unit} est sous le minimum (${s.min}${unit}).`)
      else if (s.max !== undefined && n > s.max) problems.push(`${s.env} : ${n}${unit} depasse le maximum (${s.max}${unit}).`)
      return n
    }
    switch (s.kind) {
      case 'string':
        if (/\s/.test(text)) problems.push(`${s.env} : sans espace.`)
        out[s.key] = text
        break
      case 'secret':
        if (text.length < 16) problems.push(`${s.env} : 16 caracteres au moins.`)
        if (/\s/.test(text)) problems.push(`${s.env} : sans espace.`)
        out[s.key] = text
        break
      case 'url': {
        let u: URL | undefined
        try { u = new URL(text) } catch { /* plus bas */ }
        if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) problems.push(`${s.env} : adresse http(s) absolue attendue.`)
        out[s.key] = text.replace(/\/+$/, '')
        break
      }
      case 'path':
        out[s.key] = resolve(text)
        break
      case 'int': {
        if (!/^-?\d+$/.test(text)) { problems.push(`${s.env} : entier attendu (lu « ${text} »).`); break }
        out[s.key] = range(Number(text))
        break
      }
      case 'duration': {
        const ms = parseDuration(text)
        if (ms === undefined) { problems.push(`${s.env} : duree attendue (\`500\`, \`30s\`, \`15m\`, \`24h\`, \`7d\`), lu « ${text} ».`); break }
        out[s.key] = range(ms, ' ms')
        break
      }
      case 'bytes': {
        const b = parseBytes(text)
        if (b === undefined) { problems.push(`${s.env} : taille attendue (\`65536\`, \`256KiB\`, \`32MiB\`), lu « ${text} ».`); break }
        out[s.key] = range(b, ' o')
        break
      }
      case 'enum':
        if (!s.values!.includes(text)) problems.push(`${s.env} : une valeur parmi ${s.values!.join(', ')} (lu « ${text} »).`)
        out[s.key] = text
        break
    }
  }

  const c = out as unknown as IndexerConfig
  if (oidc) c.oidc = oidc
  if (!problems.length) {
    if (c.debounceMaxMs < c.debounceMs) problems.push('SAVOIRE_INDEXER_DEBOUNCE_MAX_MS doit etre superieur ou egal a SAVOIRE_INDEXER_DEBOUNCE_MS.')
    if (c.feedIdleMs < c.feedActiveMs) problems.push('SAVOIRE_INDEXER_FEED_IDLE_MS doit etre superieur ou egal a SAVOIRE_INDEXER_FEED_ACTIVE_MS.')
    if (c.feedStaleMs <= c.feedIdleMs) problems.push('SAVOIRE_INDEXER_FEED_STALE_MS doit etre superieur a SAVOIRE_INDEXER_FEED_IDLE_MS.')
    if (c.callTimeoutMs >= 5000) warnings.push('SAVOIRE_INDEXER_CALL_TIMEOUT_MS >= 5 s : le backend (Indexer:TimeoutMs, 5 s par defaut) abandonnera avant.')
    if (c.workers > 0 && c.maxOpen < c.workers) problems.push('SAVOIRE_INDEXER_MAX_OPEN doit valoir au moins SAVOIRE_INDEXER_WORKERS.')
  }

  const known = new Set([...SETTINGS.map(s => s.env), ...EXTRA_ENV])
  for (const k of Object.keys(env)) {
    if (k.startsWith('SAVOIRE_INDEXER_') && !known.has(k)) warnings.push(`${k} : variable inconnue (ignoree). Faute de frappe ?`)
  }

  if (problems.length) throw new ConfigError(problems)
  return { config: c, warnings }
}

/** La configuration, jeton masque, pour le journal de demarrage. */
export function redacted(c: IndexerConfig): Record<string, unknown> {
  return {
    ...c,
    token: c.token ? `*** (${c.token.length} caracteres)` : '(aucun : fournisseur d\'identite)',
    errorDsn: c.errorDsn ? '***' : '(aucun)',
    ...(c.oidc ? { oidc: { ...c.oidc, clientSecret: '***' } } : {}),
  }
}

/** Table Markdown des variables (README, `--help --markdown`). */
export function settingsTable(markdown: boolean): string {
  const def = (s: Setting) => (s.def === undefined ? '(obligatoire)' : typeof s.def === 'function' ? 'auto' : s.def)
  if (markdown) {
    return ['| Variable | Defaut | Role |', '|---|---|---|',
      ...SETTINGS.map(s => `| \`${s.env}\` | \`${def(s)}\` | ${s.doc.replace(/\|/g, '\\|')} |`)].join('\n')
  }
  return SETTINGS.map(s => `${s.env} (defaut : ${def(s)})\n    ${s.doc}`).join('\n')
}
