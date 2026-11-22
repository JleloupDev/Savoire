// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le Savoire Store vu de l'application : chercher, installer, desinstaller.
//
//  - plugins : comme dans Obsidian, un plugin installe vaut pour tout le
//    vault. Le vault retient le paquet (id, version, empreinte, signature)
//    dans ses reglages partages (« store-packages ») ; chaque appareil le
//    telecharge une fois, le garde (IndexedDB), et reverifie sa signature a
//    chaque demarrage. Le plugin entre alors dans le catalogue comme ceux
//    livres avec Savoire : meme API complete dans la page (vues, editeurs de
//    fichiers, CRDT, revision...), meme activation. Un plugin « personnel »
//    (manifeste scope: personal) est retenu par le compte, dans ce navigateur.
//    Il ne tourne jamais sur le serveur ;
//  - modeles de note et modules : ce sont des notes, ajoutees au vault ouvert
//    (dossier des modeles, dossier Modules/) ;
//  - paquets de notes (une Bible...) : leurs notes sont ajoutees au vault
//    ouvert a leur chemin ; une note qui existe deja est gardee.
//
// Adresse du store : VITE_SAVOIRE_STORE_URL, sinon /store (deploiement : sous
// l'adresse de Savoire ; developpement : relaye par Vite vers 127.0.0.1:5100).
// Cle publique : VITE_SAVOIRE_STORE_KEY, sinon celle que donne le serveur
// Savoire (GET /api/v1/store/config)
// (SPKI en base64). Sans cle, en developpement seulement, l'application la
// demande au store (et le dit dans la console) ; en production, elle refuse
// d'installer.
import type { PluginAPI } from '@savoire/plugin-api'
import { templateFolderOf } from '@savoire/plugin-api'
import { StorePackageError, idAfterCreate, manifestOfPackage, notesOfPackage, setPluginFrameUrl, sha256Hex, storePlugin, verifyStorePackage, type SharedLibraryRegistry, type StorePackage } from '@savoire/plugin-runtime'
import type { IVaultSyncSession } from '@savoire/application'
import type { IIndexChannel } from '@savoire/plugin-api'
import { sandboxFrameUrl } from './tauriRuntime'
import { serverUrl } from '@savoire/infrastructure-sync'
import { removePackageEntry, setPackageEntry } from './pluginStore'

// Bureau : la page cadre des boards sert aussi aux plugins (la CSP de la fenetre bloque le JS en ligne).
setPluginFrameUrl(sandboxFrameUrl())

export interface StoreItem {
  id: string
  kind: 'plugin' | 'template' | 'module' | 'notes'
  name: string
  summary: string
  author: string
  latestVersion: string | null
  categories: string[]
  rating: number | null
  ratingCount: number
  downloads: number
  price: { cents: number; currency: string } | null
}

export interface StoreInstallResult {
  kind: StorePackage['kind']
  /** Modele ou module : la note ajoutee. */
  path?: string
  /** Paquet de notes : notes ecrites, et deja presentes (gardees). */
  written?: number
  skipped?: number
}

export interface StoreItemDetail {
  item: StoreItem
  description: string
  repo: string
  license: string | null
  homepage: string | null
  permissions: string[]
  versions: { version: string; publishedAt: string | null; sha256: string }[]
}

export interface InstalledStorePlugin {
  id: string
  name: string
  version: string
  permissions: string[]
  installedAt: string
  /** Pour tout le vault (reglages partages) ou pour soi (ce navigateur). */
  scope: 'vault' | 'personal'
  /** Qui l'a installe dans le vault. */
  installedBy?: string
  /** Pret (dans le catalogue), en echec (message). */
  state: 'running' | 'failed' | 'stopped'
  error?: string
}

/** Ce que le vault (ou le compte) retient d'un paquet installe. */
export interface PackageRecord {
  id: string
  version: string
  sha256: string
  signature: string
  name: string
  installedAt: string
  installedBy?: string
}

/** Un paquet garde dans ce navigateur (octets signes), cle id@sha256. */
interface CachedPackage {
  key: string
  id: string
  version: string
  sha256: string
  signature: string
  bytes: Uint8Array
}

/** Plugin personnel : retenu par le compte, dans ce navigateur. */
interface StoredPackage extends PackageRecord {
  key: string
  userId: string
  bytes: Uint8Array
}

/** Noms des droits, en clair (les memes que sur le site du store). */
export const PERMISSION_LABELS: Record<string, string> = {
  'vault:read': 'Lire les notes du vault',
  'vault:write': 'Modifier les notes du vault',
  'network:*': 'Accéder à Internet (tous les sites)',
  'ui:editor': 'Ajouter des commandes',
  'ui:settings': 'Ajouter des réglages',
  agents: 'Proposer des agents',
  ai: 'Utiliser votre IA',
}

export const permissionLabel = (p: string): string =>
  PERMISSION_LABELS[p] ?? (p.startsWith('network:') ? `Accéder à ${p.slice(8)}` : p)

const env = (import.meta as { env?: Record<string, string | boolean | undefined> }).env ?? {}

export function storeBaseUrl(): string {
  const configured = typeof env.VITE_SAVOIRE_STORE_URL === 'string' ? env.VITE_SAVOIRE_STORE_URL : ''
  return (configured || '/store').replace(/\/+$/, '')
}

/**
 * Message d'une reponse en erreur du store. 502 a 504 : le proxy du serveur
 * ne joint pas le store (pas installe sur ce serveur, ou arrete).
 */
export function storeHttpError(status: number): string {
  if (status >= 502 && status <= 504) return 'Le Savoire Store n\'est pas disponible sur ce serveur pour le moment.'
  return `Savoire Store : erreur ${status}.`
}

// ── Paquets gardes dans ce navigateur ─────────────────────────────────────

const DB_NAME = 'savoire-store'
/** Plugins personnels, par compte. */
const DB_STORE = 'packages'
/** Paquets des vaults, gardes par appareil (id@sha256). */
const DB_CACHE = 'cache'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'key' }).createIndex('userId', 'userId')
      if (!db.objectStoreNames.contains(DB_CACHE)) db.createObjectStore(DB_CACHE, { keyPath: 'key' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(store, mode).objectStore(store))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

const packagesOf = (userId: string) => tx<StoredPackage[]>(DB_STORE, 'readonly', s => s.index('userId').getAll(userId) as IDBRequest<StoredPackage[]>)
const savePackage = (p: StoredPackage) => tx(DB_STORE, 'readwrite', s => s.put(p))
const deletePackage = (key: string) => tx(DB_STORE, 'readwrite', s => s.delete(key))
const cached = (key: string) => tx<CachedPackage | undefined>(DB_CACHE, 'readonly', s => s.get(key) as IDBRequest<CachedPackage | undefined>)
const saveCached = (p: CachedPackage) => tx(DB_CACHE, 'readwrite', s => s.put(p))

/** Section des reglages partages du vault ou il retient ses paquets. */
export const VAULT_PACKAGES_SECTION = 'store-packages'

const isRecord = (v: unknown): v is PackageRecord => {
  const r = v as PackageRecord | null
  return !!r && typeof r.id === 'string' && typeof r.version === 'string' && typeof r.sha256 === 'string' && typeof r.signature === 'string'
}

// ── Le service ────────────────────────────────────────────────────────────

export interface SavoireStoreOptions {
  userId(): string | undefined
  /** Nom de la personne (qui a installe le plugin dans le vault). */
  userName?(): string | undefined
  /** L'API des plugins (null avant le demarrage). */
  api(): PluginAPI | null
  notify(level: 'success' | 'warn' | 'danger', title: string, message?: string): void
  /** Bibliotheques communes (React...) fournies aux plugins. */
  libraries?: SharedLibraryRegistry
  /** Reglages des plugins : installer, desinstaller (pour le vault ou pour soi). */
  settings?(): { install(id: string): void; uninstall(id: string): void; installedIds(): string[] } | null
  /** Un paquet est entre dans le catalogue (ou en est sorti) : charger ce qui est installe. */
  onCatalogChange?(): void
  baseUrl?: string
  publicKey?: string
}

export class SavoireStoreService {
  /** Paquets connus (vault + personnels), par id. */
  private readonly states = new Map<string, InstalledStorePlugin>()
  private readonly listeners = new Set<() => void>()
  private key: Promise<string> | null = null
  private loadedFor: string | undefined
  private loading: Promise<void> | null = null
  private channel: IIndexChannel | null = null
  private unsubChannel: (() => void) | null = null
  private vaultIds = new Set<string>()
  private personalIds = new Set<string>()
  private syncing: Promise<void> = Promise.resolve()

  constructor(private readonly opts: SavoireStoreOptions) {}

  get baseUrl(): string { return this.opts.baseUrl ?? storeBaseUrl() }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(): void { for (const cb of this.listeners) cb() }

  installed(): InstalledStorePlugin[] {
    return [...this.states.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  isInstalled(id: string): boolean { return this.states.has(id) }

  private async json<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}${path}`, { headers: { Accept: 'application/json' }, credentials: 'omit' })
    } catch {
      throw new Error('Le Savoire Store ne répond pas.')
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { message?: string } | null
      throw new Error(body?.message ?? storeHttpError(res.status))
    }
    return res.json() as Promise<T>
  }

  async search(q: string, kind?: string): Promise<StoreItem[]> {
    const params = new URLSearchParams({ pageSize: '50' })
    if (q.trim()) params.set('q', q.trim())
    if (kind) params.set('kind', kind)
    return (await this.json<{ items: StoreItem[] }>(`/api/v1/items?${params}`)).items
  }

  detail(id: string): Promise<StoreItemDetail> {
    return this.json<StoreItemDetail>(`/api/v1/items/${encodeURIComponent(id)}`)
  }

  /** La cle publique du store. */
  private publicKey(): Promise<string> {
    const configured = this.opts.publicKey ?? (typeof env.VITE_SAVOIRE_STORE_KEY === 'string' ? env.VITE_SAVOIRE_STORE_KEY : '')
    if (configured) return Promise.resolve(configured)
    this.key ??= (async () => {
      // Deploiement : le serveur Savoire donne la cle publique du store
      // (Store:PublicKey, separee du store lui-meme : un store compromis ne
      // peut pas la changer).
      try {
        const res = await fetch(serverUrl('/api/v1/store/config'), { headers: { Accept: 'application/json' } })
        if (res.ok) {
          const cfg = await res.json() as { publicKey?: string | null }
          if (cfg.publicKey) return cfg.publicKey
        }
      } catch { /* pas de serveur (bureau hors ligne) */ }
      if (!env.DEV) throw new StorePackageError('Clé du Savoire Store non configurée : installation impossible.')
      const k = await this.json<{ spki: string; keyId: string }>('/api/v1/signing-key')
      console.warn(`[store] developpement : cle du store lue sur le store lui-meme (${k.keyId}). En production, VITE_SAVOIRE_STORE_KEY.`)
      return k.spki
    })().catch(err => { this.key = null; throw err })
    return this.key
  }

  /** Telecharge et verifie un element (la derniere version, ou celle demandee). */
  private async download(id: string, version?: string): Promise<{ pkg: StorePackage; bytes: Uint8Array; signature: string; sha256: string }> {
    let res: Response
    const query = version ? `?version=${encodeURIComponent(version)}` : ''
    try {
      res = await fetch(`${this.baseUrl}/api/v1/items/${encodeURIComponent(id)}/download${query}`, { credentials: 'omit' })
    } catch {
      throw new Error('Le Savoire Store ne répond pas.')
    }
    if (!res.ok) throw new Error(res.status === 404 ? 'Élément introuvable sur le store.' : storeHttpError(res.status))
    const signature = res.headers.get('X-Savoire-Signature') ?? ''
    const sha256 = res.headers.get('X-Savoire-Sha256') ?? ''
    if (!signature) throw new StorePackageError('Paquet non signé : refusé.')
    const bytes = new Uint8Array(await res.arrayBuffer())
    const pkg = await verifyStorePackage(bytes, signature, await this.publicKey(), { id, version, sha256: sha256 || undefined })
    return { pkg, bytes, signature, sha256: sha256 || await sha256Hex(bytes) }
  }

  /**
   * Installe un element. Plugin : pour tout le vault (ou pour soi, s'il est
   * personnel), puis il se charge. Modele ou module : ajoute la note au vault
   * ouvert, et rend son chemin.
   */
  async install(id: string, onProgress?: (done: number, total: number) => void): Promise<StoreInstallResult> {
    const { pkg, bytes, signature, sha256 } = await this.download(id)
    if (pkg.kind === 'notes') return { kind: pkg.kind, ...await this.addNotes(pkg, onProgress) }
    if (pkg.kind !== 'plugin') return { kind: pkg.kind, path: await this.addNote(pkg) }
    const userId = this.opts.userId()
    if (!userId) throw new Error('Connectez-vous pour installer un plugin.')
    if (typeof pkg.files['main.js'] !== 'string') throw new StorePackageError('Paquet sans main.js.')
    const manifest = manifestOfPackage(pkg)
    const record: PackageRecord = {
      id, version: pkg.version, sha256, signature, name: manifest.name,
      installedAt: new Date().toISOString(), installedBy: this.opts.userName?.() ?? undefined,
    }
    await saveCached({ key: `${id}@${sha256}`, id, version: pkg.version, sha256, signature, bytes })
    if (manifest.scope === 'personal') {
      await savePackage({ ...record, key: `${userId}|${id}`, userId, bytes })
      this.personalIds.add(id)
    } else {
      if (!this.channel) throw new Error('Ouvrez un vault pour y installer ce plugin.')
      this.channel.set(id, record)
      this.vaultIds.add(id)
    }
    this.enter(pkg, record, manifest.scope === 'personal' ? 'personal' : 'vault')
    this.opts.settings?.()?.install(id)
    this.opts.onCatalogChange?.()
    return { kind: 'plugin' }
  }

  async uninstall(id: string): Promise<void> {
    const userId = this.opts.userId()
    this.opts.settings?.()?.uninstall(id)
    if (this.vaultIds.has(id)) { this.channel?.delete(id); this.vaultIds.delete(id) }
    if (this.personalIds.has(id)) { if (userId) await deletePackage(`${userId}|${id}`); this.personalIds.delete(id) }
    this.states.delete(id)
    removePackageEntry(id)
    this.changed()
  }

  /** Le vault ouvert : ses paquets entrent dans le catalogue (et ceux du precedent en sortent). */
  attachVault(session: IVaultSyncSession | undefined): void {
    this.unsubChannel?.()
    this.unsubChannel = null
    this.channel = session ? session.openVaultSettings(VAULT_PACKAGES_SECTION) : null
    for (const id of this.vaultIds) if (!this.personalIds.has(id)) { removePackageEntry(id); this.states.delete(id) }
    this.vaultIds.clear()
    this.changed()
    if (!this.channel) return
    const channel = this.channel
    this.unsubChannel = channel.onChange(() => { this.syncVault(channel) })
    this.syncVault(channel)
  }

  /** Les paquets retenus par le vault : telecharges si besoin, verifies, dans le catalogue. */
  private syncVault(channel: IIndexChannel): void {
    this.syncing = this.syncing.then(async () => {
      if (channel !== this.channel) return
      const records = channel.getAll().map(e => e.value).filter(isRecord)
      const wanted = new Set(records.map(r => r.id))
      for (const id of [...this.vaultIds]) {
        if (!wanted.has(id) && !this.personalIds.has(id)) { this.vaultIds.delete(id); this.states.delete(id); removePackageEntry(id) }
      }
      let entered = false
      for (const record of records) {
        const current = this.states.get(record.id)
        if (current && current.version === record.version && current.state !== 'failed') { this.vaultIds.add(record.id); continue }
        try {
          const pkg = await this.packageOf(record)
          if (channel !== this.channel) return
          this.vaultIds.add(record.id)
          this.enter(pkg, record, 'vault')
          entered = true
        } catch (err) {
          this.vaultIds.add(record.id)
          this.states.set(record.id, {
            id: record.id, name: record.name || record.id, version: record.version, permissions: [], installedAt: record.installedAt,
            installedBy: record.installedBy, scope: 'vault', state: 'failed', error: err instanceof Error ? err.message : String(err),
          })
          this.changed()
        }
      }
      if (entered) this.opts.onCatalogChange?.()
    }).catch(err => console.warn('[store] paquets du vault', err))
  }

  /** Le paquet d'un enregistrement : garde sur cet appareil, sinon telecharge (cette version), verifie. */
  private async packageOf(record: PackageRecord): Promise<StorePackage> {
    const key = `${record.id}@${record.sha256}`
    const hit = await cached(key).catch(() => undefined)
    if (hit) return verifyStorePackage(hit.bytes, hit.signature, await this.publicKey(), { id: record.id, sha256: record.sha256 })
    const got = await this.download(record.id, record.version)
    if (got.sha256 !== record.sha256) throw new StorePackageError('Le paquet du store ne correspond pas à celui installé dans le vault.')
    await saveCached({ key, id: record.id, version: record.version, sha256: record.sha256, signature: got.signature, bytes: got.bytes })
    return got.pkg
  }

  /** Le paquet entre dans le catalogue : il se charge s'il est installe (reglages). */
  private enter(pkg: StorePackage, record: PackageRecord, scope: 'vault' | 'personal'): void {
    const manifest = manifestOfPackage(pkg)
    const exts = Array.isArray(pkg.manifest.extensions) ? pkg.manifest.extensions.filter((e): e is string => typeof e === 'string') : []
    setPackageEntry({
      id: pkg.id, preinstalled: false, manifest, extensions: exts,
      load: async () => storePlugin(pkg, {
        libraries: this.opts.libraries,
        notify: m => this.opts.notify('success', manifest.name, m),
        onError: m => console.warn(`[store] ${m}`),
      }),
    })
    this.states.set(pkg.id, {
      id: pkg.id, name: manifest.name, version: pkg.version, permissions: manifest.permissions ?? [],
      installedAt: record.installedAt, installedBy: record.installedBy, scope, state: 'running',
    })
    this.changed()
  }

  /** Les plugins personnels du compte courant (et plus ceux d'un autre compte). */
  startInstalled(): Promise<void> {
    const userId = this.opts.userId()
    if (this.loadedFor === userId && this.loading) return this.loading
    this.loadedFor = userId
    this.loading = (async () => {
      for (const id of [...this.personalIds]) {
        this.personalIds.delete(id)
        if (!this.vaultIds.has(id)) { this.states.delete(id); removePackageEntry(id) }
      }
      this.changed()
      if (!userId || typeof indexedDB === 'undefined') return
      let stored: StoredPackage[] = []
      try { stored = await packagesOf(userId) } catch (err) { console.warn('[store] paquets illisibles', err); return }
      let entered = false
      for (const s of stored) {
        this.personalIds.add(s.id)
        try {
          const pkg = await verifyStorePackage(s.bytes, s.signature, await this.publicKey(), { id: s.id, sha256: s.sha256 })
          this.enter(pkg, s, 'personal')
          entered = true
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.states.set(s.id, { id: s.id, name: s.name || s.id, version: s.version, permissions: [], installedAt: s.installedAt, scope: 'personal', state: 'failed', error: message })
          this.changed()
        }
      }
      if (entered) this.opts.onCatalogChange?.()
    })()
    return this.loading
  }

  /** Un paquet de notes : chaque note a son chemin, sauf celles qui existent deja. */
  private async addNotes(pkg: StorePackage, onProgress?: (done: number, total: number) => void): Promise<{ written: number; skipped: number }> {
    const api = this.opts.api()
    const vault = api?.vault
    if (!vault?.createFile || !api) throw new Error('Ouvrez un vault pour y ajouter ces notes.')
    const notes = notesOfPackage(pkg)
    let written = 0
    let skipped = 0
    for (const [i, note] of notes.entries()) {
      if (vault.resolveDocumentId(note.path)) skipped++
      else {
        await vault.createFile(note.path)
        const docId = await idAfterCreate(api, note.path)
        if (vault.editText) await vault.editText(docId, () => note.text)
        else await vault.write(docId, note.text)
        written++
      }
      onProgress?.(i + 1, notes.length)
    }
    return { written, skipped }
  }

  /** Un modele ou un module : une note ajoutee au vault ouvert. */
  private async addNote(pkg: StorePackage): Promise<string> {
    const api = this.opts.api()
    const vault = api?.vault
    if (!vault?.createFile || !api) throw new Error('Ouvrez un vault pour y ajouter ce modèle.')
    const text = pkg.kind === 'template' ? pkg.files['template.md'] : pkg.files['module.md']
    if (typeof text !== 'string') throw new StorePackageError('Paquet incomplet.')
    let folder = 'Modules/'
    if (pkg.kind === 'template') {
      const files = await listAll(api)
      folder = templateFolderOf(files) ?? 'Modèles/'
    }
    const base = (pkg.manifest.name || pkg.id).replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || pkg.id
    let path = `${folder}${base}.md`
    for (let n = 2; vault.resolveDocumentId(path); n++) path = `${folder}${base} ${n}.md`
    await vault.createFile(path)
    const id = await idAfterCreate(api, path)
    if (vault.editText) await vault.editText(id, () => text)
    else await vault.write(id, text)
    return path
  }
}

async function listAll(api: PluginAPI): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length && files.length < 50_000) {
    const dir = queue.shift()!
    for (const entry of await api.vault.list(dir || undefined)) {
      if (entry.endsWith('/')) { if (entry !== dir) queue.push(entry) }
      else files.push(entry)
    }
  }
  return files
}
