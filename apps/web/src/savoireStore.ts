// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le Savoire Store vu de l'application : chercher, installer, desinstaller.
//
//  - plugins : le paquet signe est garde dans ce navigateur (IndexedDB), pour
//    chaque compte ; sa signature est reverifiee a chaque demarrage. Le code
//    tourne dans une iframe isolee (FramedPlugin), jamais dans la page ;
//  - modeles de note et modules : ce sont des notes, ajoutees au vault ouvert
//    (dossier des modeles, dossier Modules/).
//
// Adresse du store : VITE_SAVOIRE_STORE_URL (developpement : /store, relaye
// par Vite vers 127.0.0.1:5100). Cle publique : VITE_SAVOIRE_STORE_KEY
// (SPKI en base64). Sans cle, en developpement seulement, l'application la
// demande au store (et le dit dans la console) ; en production, elle refuse
// d'installer.
import type { PluginAPI } from '@savoire/plugin-api'
import { templateFolderOf } from '@savoire/plugin-api'
import { FramedPlugin, StorePackageError, idAfterCreate, setPluginFrameUrl, sha256Hex, verifyStorePackage, type StorePackage } from '@savoire/plugin-runtime'
import { boardFrameUrl } from './tauriRuntime'

// Bureau : la page cadre des boards sert aussi aux plugins (la CSP de la fenetre bloque le JS en ligne).
setPluginFrameUrl(boardFrameUrl())

export interface StoreItem {
  id: string
  kind: 'plugin' | 'template' | 'module'
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
  /** En marche, en echec (message), ou arrete. */
  state: 'running' | 'failed' | 'stopped'
  error?: string
}

interface StoredPackage {
  key: string
  userId: string
  id: string
  version: string
  signature: string
  sha256: string
  bytes: Uint8Array
  installedAt: string
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

// ── Paquets gardes dans ce navigateur ─────────────────────────────────────

const DB_NAME = 'savoire-store'
const DB_STORE = 'packages'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(DB_STORE, { keyPath: 'key' })
      s.createIndex('userId', 'userId')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(DB_STORE, mode).objectStore(DB_STORE))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

const packagesOf = (userId: string) => tx<StoredPackage[]>('readonly', s => s.index('userId').getAll(userId) as IDBRequest<StoredPackage[]>)
const savePackage = (p: StoredPackage) => tx('readwrite', s => s.put(p))
const deletePackage = (key: string) => tx('readwrite', s => s.delete(key))

// ── Le service ────────────────────────────────────────────────────────────

export interface SavoireStoreOptions {
  userId(): string | undefined
  /** L'API des plugins (null avant le demarrage). */
  api(): PluginAPI | null
  notify(level: 'success' | 'warn' | 'danger', title: string, message?: string): void
  baseUrl?: string
  publicKey?: string
}

export class SavoireStoreService {
  private readonly running = new Map<string, FramedPlugin>()
  private readonly states = new Map<string, InstalledStorePlugin>()
  private readonly listeners = new Set<() => void>()
  private key: Promise<string> | null = null
  private loadedFor: string | undefined
  private loading: Promise<void> | null = null

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
      throw new Error(body?.message ?? `Savoire Store : erreur ${res.status}.`)
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
      if (!env.DEV) throw new StorePackageError('Clé du Savoire Store non configurée : installation impossible.')
      const k = await this.json<{ spki: string; keyId: string }>('/api/v1/signing-key')
      console.warn(`[store] developpement : cle du store lue sur le store lui-meme (${k.keyId}). En production, VITE_SAVOIRE_STORE_KEY.`)
      return k.spki
    })().catch(err => { this.key = null; throw err })
    return this.key
  }

  /** Telecharge et verifie la derniere version d'un element. */
  private async download(id: string): Promise<{ pkg: StorePackage; bytes: Uint8Array; signature: string; sha256: string }> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl}/api/v1/items/${encodeURIComponent(id)}/download`, { credentials: 'omit' })
    } catch {
      throw new Error('Le Savoire Store ne répond pas.')
    }
    if (!res.ok) throw new Error(res.status === 404 ? 'Élément introuvable sur le store.' : `Savoire Store : erreur ${res.status}.`)
    const signature = res.headers.get('X-Savoire-Signature') ?? ''
    const sha256 = res.headers.get('X-Savoire-Sha256') ?? ''
    if (!signature) throw new StorePackageError('Paquet non signé : refusé.')
    const bytes = new Uint8Array(await res.arrayBuffer())
    const pkg = await verifyStorePackage(bytes, signature, await this.publicKey(), { id, sha256: sha256 || undefined })
    return { pkg, bytes, signature, sha256: sha256 || await sha256Hex(bytes) }
  }

  /**
   * Installe un element. Plugin : garde et demarre. Modele ou module :
   * ajoute la note au vault ouvert, et rend son chemin.
   */
  async install(id: string): Promise<{ kind: StorePackage['kind']; path?: string }> {
    const { pkg, bytes, signature, sha256 } = await this.download(id)
    if (pkg.kind !== 'plugin') return { kind: pkg.kind, path: await this.addNote(pkg) }
    const userId = this.opts.userId()
    if (!userId) throw new Error('Connectez-vous pour installer un plugin.')
    if (typeof pkg.files['main.js'] !== 'string') throw new StorePackageError('Paquet sans main.js.')
    await this.stopOne(id)
    await savePackage({ key: `${userId}|${id}`, userId, id, version: pkg.version, signature, sha256, bytes, installedAt: new Date().toISOString() })
    await this.startOne(pkg, new Date().toISOString())
    return { kind: 'plugin' }
  }

  async uninstall(id: string): Promise<void> {
    const userId = this.opts.userId()
    await this.stopOne(id)
    this.states.delete(id)
    if (userId) await deletePackage(`${userId}|${id}`)
    this.changed()
  }

  /** Demarre les plugins installes du compte courant (et arrete ceux d'un autre compte). */
  startInstalled(): Promise<void> {
    const userId = this.opts.userId()
    if (this.loadedFor === userId && this.loading) return this.loading
    this.loadedFor = userId
    this.loading = (async () => {
      for (const id of [...this.running.keys()]) await this.stopOne(id)
      this.states.clear()
      this.changed()
      if (!userId || typeof indexedDB === 'undefined') return
      let stored: StoredPackage[] = []
      try { stored = await packagesOf(userId) } catch (err) { console.warn('[store] paquets illisibles', err); return }
      for (const s of stored) {
        try {
          const pkg = await verifyStorePackage(s.bytes, s.signature, await this.publicKey(), { id: s.id, sha256: s.sha256 })
          await this.startOne(pkg, s.installedAt)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.states.set(s.id, { id: s.id, name: s.id, version: s.version, permissions: [], installedAt: s.installedAt, state: 'failed', error: message })
          this.changed()
        }
      }
    })()
    return this.loading
  }

  private async startOne(pkg: StorePackage, installedAt: string): Promise<void> {
    const api = this.opts.api()
    const info: InstalledStorePlugin = {
      id: pkg.id, name: pkg.manifest.name || pkg.id, version: pkg.version,
      permissions: (pkg.manifest.permissions ?? []).filter(p => typeof p === 'string'), installedAt, state: 'stopped',
    }
    this.states.set(pkg.id, info)
    if (!api) { info.state = 'failed'; info.error = 'Application pas encore prête.'; this.changed(); return }
    const framed = new FramedPlugin({
      id: pkg.id, name: info.name, code: pkg.files['main.js'] ?? '', permissions: info.permissions, api,
      notify: m => this.opts.notify('success', info.name, m),
      onError: m => console.warn(`[store] ${m}`),
    })
    this.running.set(pkg.id, framed)
    try {
      await framed.start()
      info.state = 'running'
    } catch (err) {
      this.running.delete(pkg.id)
      info.state = 'failed'
      info.error = err instanceof Error ? err.message : String(err)
    }
    this.changed()
  }

  private async stopOne(id: string): Promise<void> {
    const framed = this.running.get(id)
    this.running.delete(id)
    if (framed) await framed.stop()
    const s = this.states.get(id)
    if (s && s.state === 'running') s.state = 'stopped'
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
