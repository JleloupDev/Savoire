// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Session de vault SUR UN DOSSIER du disque (version bureau). Un vault est
// range comme dans Obsidian : un dossier ordinaire, les notes en texte clair,
// les images telles quelles. Ce que le texte ne porte pas vit dans
// `.savoire/` (voir vaultFolderFormat.ts et
// docs/Architecture/desktop-vault-format.md).
//
// Qui est la verite :
//   - repertoire : les fichiers du dossier. Les ids stables sont gardes dans
//     `.savoire/documents.json` ;
//   - document CRDT textuel (.md...) : l'etat Yjs dans `.savoire/crdt/<id>/`,
//     projete dans le fichier visible. Une modification du fichier faite
//     ailleurs est relue et appliquee au texte par un diff minimal ;
//   - document CRDT non textuel (page, Excalidraw, carte mentale, chat) :
//     l'etat seul. Le fichier visible n'est jamais reecrit par le CRDT : il
//     garde l'ancien contenu (lu par le plugin pour sa migration) ;
//   - document snapshot et piece jointe : le fichier lui-meme.
//
// Un seul utilisateur local : ni verrous ni partage (capacites absentes).
// Deux sessions sur le meme dossier (deux fenetres) se voient par `watch` :
// mises a jour CRDT en fichiers ajoutes, jamais reecrits. Limite connue : une
// modification externe vue au meme instant par deux sessions dont l'etat
// differe peut etre appliquee deux fois.
//
// Toutes les operations qui touchent aux chemins passent par UNE file, dans
// l'ordre ou l'application les a demandees : le disque suit le repertoire.
import * as Y from 'yjs'
import type { ICRDT, IIndexChannel, ISharedText, ISharedTree } from '@savoire/plugin-api'
import type {
  DocumentSyncKind, FileChange, ISnapshotDocument, IVaultFileSystem, IVaultFiles,
} from '@savoire/platform'
import type { IVaultSyncSession, IVaultSyncSessionFactory, VaultSyncSessionFactoryParams } from '@savoire/application'
import { YjsCrdtAdapter } from '../YjsCrdtAdapter'
import { YMapIndexChannel } from '../YMapIndexChannel'
import { SnapshotDocuments, type SnapshotChannel } from '../SnapshotDocuments'
import { bytesToBase64 } from '../base64'
import { FileSystemVaultDirectory } from './FileSystemVaultDirectory'
import { UpdateLog } from './UpdateLog'
import { diffText } from './textDiff'
import {
  CRDT_DIR, DEFAULT_TEXT_EXTENSIONS, DETACHED_DIR, DOCUMENTS_PATH, MAPS_DIR, SAVOIRE_DIR, VAULT_FORMAT_VERSION,
  VAULT_META_PATH, UnsupportedVaultFormatError, contentHash, crdtDirOf, detachedPathOf, deterministicClientId,
  discoveredDocumentId, hasExtension, initializeVaultFolder, isVaultFolder, isVaultPath, mapDirOf, mimeTypeOf,
  readVaultFolderMeta, snapshotMetaOf, type DocumentIdEntry, type DocumentsFile, type VaultFolderMeta,
} from './vaultFolderFormat'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Y_ = Y as Record<string, any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YDoc = any

/** Origines des mises a jour d'une replique. */
const FROM_DISK = 'fs:disk'       // lue dans `.savoire/` (autre session, reouverture)
const FROM_EDITOR = 'fs:editor'   // frappe dans l'editeur ouvert
const FROM_FILE = 'fs:file'       // modification du fichier visible faite ailleurs
const FROM_SEED = 'fs:seed'       // premier etat tire d'un fichier sans etat (vault Obsidian)
const FROM_MERGE = 'fs:merge'     // mergeDocumentState (copie d'un vault)

/** Auteur d'une ecriture snapshot faite par un autre outil que Savoire. */
export const EXTERNAL_WRITER_ID = 'external'

/** Dernieres projections gardees par document (voir isProjection). */
const PROJECTIONS_KEPT = 8

export interface FileSystemVaultSessionOptions {
  /** Regroupement des modifications CRDT avant ecriture dans `.savoire/` (ms). Defaut 300. */
  persistMs?: number
  /** Anti-rebond de l'ecriture du fichier visible d'un texte (ms). Defaut 400. */
  projectMs?: number
  /** Anti-rebond de la relecture du dossier apres un changement du disque (ms). Defaut 100. */
  scanMs?: number
  /**
   * Un document CRDT a ce chemin est-il un texte (projete dans le fichier
   * visible, modifications externes relues) ? Defaut : .md, .markdown, .txt,
   * .outline. Les autres documents CRDT (arbre) gardent leur etat seul.
   */
  isTextDocument?: (path: string) => boolean
}

interface DocReplica {
  doc: YDoc
  log: UpdateLog
  refs: number
  loaded: Promise<void>
  /**
   * Dernier accord connu entre le fichier visible et le CRDT : le texte du
   * fichier et l'etat Yjs qui le donnait. Une modification externe se lit
   * comme un diff DEPUIS cet accord, applique sur cet etat : les frappes
   * locales posterieures (pas encore ecrites) sont fusionnees, pas effacees.
   */
  base?: { text: string; state: Uint8Array }
  /** Contenu du fichier reconnu comme une projection perimee, a reecrire. */
  staleFile?: string
  /** Empreintes de nos dernieres projections. */
  projected: string[]
}

interface OpenDoc {
  crdt: YjsCrdtAdapter
  replica: DocReplica
  attached: boolean
  buffer: Uint8Array[]
  unsubs: (() => void)[]
}

interface SharedMapEntry {
  channel: YMapIndexChannel
  log: UpdateLog
  pull(): Promise<void>
}

interface SnapshotState {
  lastDisk?: string
  listeners: Set<(content: string, from: string) => void>
}

interface SnapshotMeta {
  userId: string
  session: string
  hash: string
}

function ytextOf(doc: YDoc): { toString(): string; length: number; insert(i: number, s: string): void; delete(i: number, n: number): void } {
  return doc.getText('codemirror')
}

function stripSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function splitExtension(path: string): { base: string; ext: string } {
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot > slash + 1 ? { base: path.slice(0, dot), ext: path.slice(dot) } : { base: path, ext: '' }
}

export class FileSystemVaultSession implements IVaultSyncSession {
  readonly directory: FileSystemVaultDirectory
  readonly files: IVaultFiles
  /** Id unique de cette session : nomme ses fichiers de mises a jour. */
  readonly sessionId = crypto.randomUUID().slice(0, 8)

  private readonly persistMs: number
  private readonly projectMs: number
  private readonly scanMs: number
  private readonly isText: (path: string) => boolean

  private readonly replicas = new Map<string, DocReplica>()
  private readonly replicasByDir = new Map<string, { docId: string; replica: DocReplica }>()
  private readonly releasing = new Map<string, Promise<void>>()
  private readonly openDocs = new Map<string, OpenDoc>()
  private readonly projectTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly maps = new Map<string, SharedMapEntry>()
  private readonly mapsByDir = new Map<string, SharedMapEntry>()
  private readonly snapshots: SnapshotDocuments
  private readonly snapshotStates = new Map<string, SnapshotState>()
  private readonly urlCache = new Map<string, { url: string; path: string; mtimeMs?: number }>()
  private readonly uploadTypes = new Map<string, string>()

  /** Ids stables : contenu de `.savoire/documents.json`, plus nos changements. */
  private ids = new Map<string, DocumentIdEntry>()
  private readonly dirtyIds = new Set<string>()
  private readonly deletedIds = new Set<string>()
  /** Dossiers crees expres (voir DocumentsFile.folders), et nos changements pas encore ecrits. */
  private explicitFolders = new Set<string>()
  private readonly addedFolders = new Set<string>()
  private readonly removedFolders = new Set<string>()
  private idsTimer: ReturnType<typeof setTimeout> | null = null
  private lastIdsWritten = ''

  private queue: Promise<void> = Promise.resolve()
  private pendingOps = 0
  private localGen = 0
  private scanTimer: ReturnType<typeof setTimeout> | null = null
  private unwatch: (() => void) | null = null
  private readonly unsubDirectoryChange: () => void
  private disposed = false
  private gone = false

  /** Ouvre un dossier comme vault ; un dossier sans `.savoire/` est initialise sans toucher aux notes. */
  static async open(
    fs: IVaultFileSystem,
    params: VaultSyncSessionFactoryParams,
    options: FileSystemVaultSessionOptions = {},
  ): Promise<FileSystemVaultSession> {
    const meta = (await readVaultFolderMeta(fs)) ?? (await initializeVaultFolder(fs, { id: params.vaultId }))
    if (meta.format > VAULT_FORMAT_VERSION) throw new UnsupportedVaultFormatError(meta.format)
    if (meta.id !== params.vaultId) {
      console.warn(`[FileSystemVaultSession] le dossier ${fs.rootLabel} porte le vault ${meta.id}, ouvert sous ${params.vaultId}`)
    }
    const session = new FileSystemVaultSession(fs, params, meta, options)
    await session.start()
    return session
  }

  private constructor(
    private readonly fs: IVaultFileSystem,
    private readonly params: VaultSyncSessionFactoryParams,
    /** Informations du vault (`.savoire/vault.json`). */
    readonly vaultMeta: VaultFolderMeta,
    options: FileSystemVaultSessionOptions,
  ) {
    this.persistMs = options.persistMs ?? 300
    this.projectMs = options.projectMs ?? 400
    this.scanMs = options.scanMs ?? 100
    this.isText = options.isTextDocument ?? (path => hasExtension(path, DEFAULT_TEXT_EXTENSIONS))
    this.directory = new FileSystemVaultDirectory({
      added: (id, path) => this.localOp(() => this.diskAdd(id, path)),
      renamed: (id, from, to) => this.localOp(() => this.diskRename(id, from, to)),
      removed: (id, path) => this.localOp(() => this.diskRemove(id, path)),
      folderAdded: path => this.localOp(() => this.diskAddFolder(path)),
      folderRemoved: path => this.localOp(() => this.diskRemoveFolder(path)),
    })
    this.unsubDirectoryChange = this.directory.onChange(params.onChanged)
    this.snapshots = new SnapshotDocuments(docId => this.snapshotChannel(docId))
    this.files = {
      upload: (fileId, file) => this.uploadFile(fileId, file),
      url: fileId => this.fileUrl(fileId),
      read: async fileId => new TextDecoder().decode((await this.readFileBytes(fileId)).bytes),
      readBytes: fileId => this.readFileBytes(fileId),
    }
  }

  private async start(): Promise<void> {
    await this.loadIds()
    await this.scan(true)
    await this.saveIds()
    this.unwatch = this.fs.watch?.(changes => this.onDiskChanges(changes)) ?? null
    this.params.onConnectionChange?.('connected')
  }

  // ── Documents CRDT ─────────────────────────────────────────────────────────

  openDocument(docId: string): ICRDT {
    const existing = this.openDocs.get(docId)
    if (existing) return existing.crdt
    const crdt = new YjsCrdtAdapter()
    crdt.setLocalUser(this.params.userId)
    const replica = this.acquireReplica(docId)
    const open: OpenDoc = { crdt, replica, attached: false, buffer: [], unsubs: [] }
    open.unsubs.push(crdt.onLocalOp(update => {
      if (open.attached) Y_.applyUpdate(replica.doc, update, FROM_EDITOR)
      else open.buffer.push(update)
    }))
    this.openDocs.set(docId, open)
    // Rendu vide ; l'etat arrive ensuite, comme des mises a jour distantes
    // (voir IVaultSyncSession.openDocument).
    void replica.loaded.then(() => {
      if (this.openDocs.get(docId) !== open) return
      for (const u of open.buffer) Y_.applyUpdate(replica.doc, u, FROM_EDITOR)
      open.buffer = []
      open.attached = true
      crdt.applyRemoteOp(Y_.encodeStateAsUpdate(replica.doc))
    })
    return crdt
  }

  closeDocument(docId: string): void {
    const open = this.openDocs.get(docId)
    if (!open) return
    this.openDocs.delete(docId)
    for (const unsub of open.unsubs) unsub()
    for (const u of open.buffer) Y_.applyUpdate(open.replica.doc, u, FROM_EDITOR)
    open.crdt.dispose()
    this.releaseReplica(docId, open.replica)
  }

  appendText(docId: string, text: string): void {
    const open = this.openDocs.get(docId)
    if (!open) throw new Error(`appendText : le document ${docId} n'est pas ouvert`)
    const ytext = ytextOf(open.crdt.rawDoc)
    ytext.insert(ytext.length, text)
  }

  openText(docId: string): ISharedText {
    const open = this.openDocs.get(docId)
    if (!open) throw new Error(`openText : le document ${docId} n'est pas ouvert`)
    return open.crdt.sharedText()
  }

  openTree(docId: string): ISharedTree {
    const open = this.openDocs.get(docId)
    if (!open) throw new Error(`openTree : le document ${docId} n'est pas ouvert`)
    return open.crdt.sharedTree()
  }

  async readDocumentState(docId: string): Promise<Uint8Array> {
    const replica = this.acquireReplica(docId)
    try {
      await replica.loaded
      return Y_.encodeStateAsUpdate(replica.doc) as Uint8Array
    } finally {
      this.releaseReplica(docId, replica)
    }
  }

  async mergeDocumentState(docId: string, state: Uint8Array): Promise<void> {
    const replica = this.acquireReplica(docId)
    try {
      await replica.loaded
      Y_.applyUpdate(replica.doc, state, FROM_MERGE)
      await replica.log.flush()
      await this.enqueue(() => this.projectNow(docId, replica))
    } finally {
      this.releaseReplica(docId, replica)
    }
  }

  // ── Documents snapshot et lecture ponctuelle ───────────────────────────────

  /** Un seul utilisateur local, aucun gardien a prevenir. */
  async registerDocuments(_docIds: string[]): Promise<void> {}

  openSnapshot(docId: string): ISnapshotDocument {
    return this.snapshots.open(docId)
  }

  closeSnapshot(docId: string): void {
    this.snapshots.close(docId)
  }

  async readDocument(docId: string, kind: DocumentSyncKind): Promise<string> {
    if (kind === 'snapshot') return this.snapshots.read(docId)
    const loaded = this.replicas.get(docId)
    if (!loaded) {
      // Texte ferme : le fichier visible est a jour, inutile de charger l'etat.
      const path = this.directory.pathOf(docId)
      if (path && this.isText(path)) {
        const text = await this.enqueue(async () => (await this.fs.exists(path)) ? this.fs.readText(path) : null)
        if (text !== null) return text
      }
    }
    const replica = this.acquireReplica(docId)
    try {
      await replica.loaded
      return ytextOf(replica.doc).toString()
    } finally {
      this.releaseReplica(docId, replica)
    }
  }

  // ── Cartes partagees ───────────────────────────────────────────────────────

  openIndex(namespace: string): IIndexChannel {
    const existing = this.maps.get(namespace)
    if (existing) return existing.channel
    const dir = mapDirOf(namespace)
    let deliver: ((update: Uint8Array) => void) | null = null
    // eslint-disable-next-line prefer-const
    let channel: YMapIndexChannel
    const log = new UpdateLog(this.fs, dir, this.sessionId, {
      persistMs: this.persistMs,
      fullState: () => channel.encodeState(),
      onError: err => this.reportError(err),
    })
    channel = new YMapIndexChannel(namespace, {
      push: (_ns, update) => log.append(update),
      subscribe: (_ns, cb) => { deliver = cb; return () => { deliver = null } },
    })
    const entry: SharedMapEntry = {
      channel,
      log,
      pull: async () => { for (const u of await log.readNew()) deliver?.(u) },
    }
    this.maps.set(namespace, entry)
    this.mapsByDir.set(dir, entry)
    channel.markLoaded(entry.pull().catch(err => this.reportError(err)))
    return channel
  }

  openVaultSettings(section: string): IIndexChannel {
    return this.openIndex(`settings/${section}`)
  }

  openSharedMap(name: string): IIndexChannel {
    return this.openIndex(`map/${name}`)
  }

  // ── Etat de la session ─────────────────────────────────────────────────────

  getState(): 'connected' | 'connecting' | 'disconnected' {
    return this.disposed ? 'disconnected' : 'connected'
  }

  /**
   * Ecrit tout ce qui attend : mises a jour CRDT, cartes, fichiers visibles
   * des textes, ids. Rend quand tout est sur le disque.
   */
  async flush(): Promise<void> {
    // Les documents en cours d'ouverture d'abord : leurs frappes en attente rejoignent l'etat.
    await Promise.all([...this.replicas.values()].map(r => r.loaded.catch(() => {})))
    for (const [docId, timer] of [...this.projectTimers]) {
      clearTimeout(timer)
      this.projectTimers.delete(docId)
      this.background(() => this.projectNow(docId))
    }
    await Promise.all([
      ...[...this.replicas.values()].map(r => r.log.flush()),
      ...[...this.maps.values()].map(m => m.log.flush()),
    ])
    if (this.idsTimer) { clearTimeout(this.idsTimer); this.idsTimer = null }
    await this.enqueue(() => this.saveIds())
  }

  /**
   * Relit le disque : dossier, textes ouverts, snapshots ouverts, cartes.
   * Sans `watch` (systeme qui ne sait pas surveiller), l'application
   * l'appelle quand elle reprend la main (fenetre de nouveau active).
   */
  async refresh(): Promise<void> {
    const jobs: Promise<unknown>[] = [this.enqueue(() => this.scan())]
    for (const docId of this.replicas.keys()) jobs.push(this.enqueue(() => this.ingest(docId)))
    for (const docId of this.snapshotStates.keys()) jobs.push(this.enqueue(() => this.checkSnapshot(docId)))
    for (const m of this.maps.values()) jobs.push(m.pull())
    await Promise.all(jobs)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unwatch?.()
    this.unwatch = null
    if (this.scanTimer) { clearTimeout(this.scanTimer); this.scanTimer = null }
    try {
      await this.flush()
    } catch (err) {
      this.reportError(err)
    }
    for (const docId of [...this.openDocs.keys()]) this.closeDocument(docId)
    await Promise.all([...this.releasing.values()])
    for (const m of this.maps.values()) {
      await m.log.compact().catch(err => this.reportError(err))
      m.log.dispose()
      m.channel.dispose()
    }
    this.maps.clear()
    this.mapsByDir.clear()
    this.snapshots.dispose()
    // Dernieres tailles et dates (projections faites a la fermeture des documents).
    if (this.idsTimer) { clearTimeout(this.idsTimer); this.idsTimer = null }
    await this.enqueue(() => this.saveIds()).catch(err => this.reportError(err))
    for (const c of this.urlCache.values()) URL.revokeObjectURL(c.url)
    this.urlCache.clear()
    this.unsubDirectoryChange()
    this.directory.dispose()
    this.params.onConnectionChange?.('disconnected')
  }

  // ── File des operations ────────────────────────────────────────────────────

  /** Met une operation dans la file ; l'appelant recoit son resultat ou son erreur. */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job)
    this.queue = run.then(() => {}, () => {})
    return run
  }

  /** Operation de fond : personne n'attend, une erreur est signalee. */
  private background(job: () => Promise<unknown>): void {
    this.enqueue(job).catch(err => this.reportError(err))
  }

  /** Changement de l'application a realiser sur le disque. */
  private localOp(job: () => Promise<void>): void {
    this.localGen++
    this.pendingOps++
    this.background(async () => {
      try { await job() } finally { this.pendingOps-- }
    })
  }

  private reportError(err: unknown): void {
    if (this.disposed && this.gone) return
    console.warn('[FileSystemVaultSession]', err)
  }

  // ── Repertoire -> disque ───────────────────────────────────────────────────

  private async diskAdd(id: string, path: string): Promise<void> {
    this.setId(id, { path }, true)
    // Ids d'abord : une autre session qui voit le fichier apparaitre connait deja son id.
    await this.saveIds()
    if (!(await this.fs.exists(path))) {
      const detached = detachedPathOf(id)
      if (await this.fs.exists(detached)) await this.fs.rename(detached, path)
      else {
        // Fichier vide d'un texte : note comme projection, pour qu'un etat
        // deja la (ecrit avant le fichier) ne soit jamais efface par lui.
        if (this.isText(path)) await this.rememberProjection(id, this.replicas.get(id) ?? null, '')
        await this.fs.writeText(path, '')
      }
      if (await this.fs.exists(`${detached}.json`)) await this.fs.remove(`${detached}.json`)
    }
    await this.refreshMeta(id, path)
    this.forgetUrl(id)
    // Un texte qui avait deja un etat (document sans chemin, copie d'un vault) :
    // le fichier visible le montre.
    if (this.isText(path)) await this.projectFromState(id)
  }

  private async diskRename(id: string, from: string, to: string): Promise<void> {
    if (from === to) return
    let target = to
    if (await this.fs.exists(from)) {
      if (await this.fs.exists(to)) {
        // Jamais ecraser un fichier : la cible prend un suffixe.
        target = await this.freePath(to)
        this.directory.setPathFromDisk(id, target)
      }
      this.setId(id, { ...this.ids.get(id), path: target }, true)
      await this.saveIds()
      await this.fs.rename(from, target)
      await this.refreshMeta(id, target)
      await this.removeEmptyParents(from)
    } else {
      this.setId(id, { ...this.ids.get(id), path: target }, true)
      await this.saveIds()
    }
    this.forgetUrl(id)
  }

  private async diskRemove(id: string, path: string): Promise<void> {
    this.deleteId(id)
    await this.saveIds()
    if (await this.fs.exists(path)) {
      await this.fs.remove(path)
      await this.removeEmptyParents(path)
    }
    // Supprime pour de bon : son etat aussi.
    for (const p of [crdtDirOf(id), snapshotMetaOf(id), detachedPathOf(id), `${detachedPathOf(id)}.json`]) {
      if (this.replicas.has(id) && p === crdtDirOf(id)) continue
      if (await this.fs.exists(p)) await this.fs.remove(p)
    }
    this.forgetUrl(id)
  }

  private async diskAddFolder(path: string): Promise<void> {
    const folder = path.endsWith('/') ? path : `${path}/`
    this.addedFolders.add(folder)
    this.removedFolders.delete(folder)
    this.explicitFolders.add(folder)
    await this.saveIds(true)
    await this.fs.mkdir(stripSlash(path))
  }

  /** Un dossier ne quitte le disque que s'il ne contient plus aucun fichier. */
  private async diskRemoveFolder(path: string): Promise<void> {
    const folder = path.endsWith('/') ? path : `${path}/`
    this.removedFolders.add(folder)
    this.addedFolders.delete(folder)
    this.explicitFolders.delete(folder)
    await this.saveIds(true)
    const dir = stripSlash(path)
    if (!(await this.fs.exists(dir))) return
    const inside = await this.fs.list(dir, { recursive: true })
    if (inside.every(e => e.kind === 'directory')) await this.fs.remove(dir)
  }

  /**
   * Le dernier fichier d'un dossier est parti (deplace, corbeille) : le
   * dossier vide quitte le disque, comme dans les autres profils ou un
   * dossier n'existe que par ses documents. Un dossier cree expres reste.
   */
  private async removeEmptyParents(path: string): Promise<void> {
    let dir = path.slice(0, Math.max(0, path.lastIndexOf('/')))
    while (dir && !this.explicitFolders.has(`${dir}/`)) {
      if (!(await this.fs.exists(dir)) || (await this.fs.list(dir)).length > 0) return
      await this.fs.remove(dir)
      dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')))
    }
  }

  private async freePath(path: string): Promise<string> {
    const { base, ext } = splitExtension(path)
    let n = 1
    while (await this.fs.exists(`${base} ${n}${ext}`) || this.directory.idAt(`${base} ${n}${ext}`)) n++
    return `${base} ${n}${ext}`
  }

  // ── Disque -> repertoire ───────────────────────────────────────────────────

  private scheduleScan(): void {
    if (this.scanTimer || this.disposed) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null
      this.background(() => this.scan())
    }, this.scanMs)
  }

  /**
   * Relit le dossier et en tire le repertoire. Un fichier garde son id par
   * son chemin ; un fichier inconnu prend l'id d'un document disparu s'il lui
   * ressemble (renommage fait ailleurs), sinon un id tire de son chemin.
   */
  private async scan(initial = false): Promise<void> {
    if (this.disposed && !initial) return
    // Un changement de l'application attend son tour : le disque est en retard sur lui.
    if (this.pendingOps > 0) { this.scheduleScan(); return }
    const gen = this.localGen
    let entries
    try {
      entries = await this.fs.list('', { recursive: true })
    } catch (err) {
      if (!initial && !(await this.fs.exists(VAULT_META_PATH).catch(() => false))) return this.vaultGone()
      throw err
    }
    if (!initial && !entries.some(e => e.path === VAULT_META_PATH)) return this.vaultGone()
    await this.loadIds()

    const present = new Map<string, { size?: number; mtimeMs?: number }>()
    const folders = new Set<string>()
    for (const e of entries) {
      if (e.kind === 'file' && isVaultPath(e.path)) present.set(e.path, { size: e.size, mtimeMs: e.mtimeMs })
      else if (e.kind === 'directory' && isVaultFolder(e.path)) folders.add(`${e.path}/`)
    }

    const idsByPath = new Map<string, string>()
    for (const [id, entry] of this.ids) idsByPath.set(entry.path, id)
    const current = this.directory.getAll()
    const currentByPath = new Map(current.map(d => [d.path, d.id]))

    const assigned = new Map<string, string>()
    const used = new Set<string>()
    const unassigned: string[] = []
    for (const path of present.keys()) {
      const id = idsByPath.get(path) ?? currentByPath.get(path)
      if (id && !used.has(id)) { assigned.set(id, path); used.add(id) } else unassigned.push(path)
    }

    // Documents disparus : candidats a un renommage fait ailleurs.
    const candidates = new Map<string, DocumentIdEntry>()
    for (const [id, entry] of this.ids) if (!used.has(id) && !present.has(entry.path)) candidates.set(id, entry)
    for (const d of current) if (!used.has(d.id) && !candidates.has(d.id) && !present.has(d.path)) candidates.set(d.id, { path: d.path })

    for (const path of unassigned.sort()) {
      const stat = present.get(path)!
      let id = await this.matchRename(path, stat, candidates)
      if (id) candidates.delete(id)
      else {
        id = await discoveredDocumentId(this.vaultMeta.id, path)
        if (used.has(id)) id = crypto.randomUUID()
      }
      assigned.set(id, path)
      used.add(id)
    }

    // L'application a change le repertoire pendant la lecture : on recommence.
    if (gen !== this.localGen || this.pendingOps > 0) { this.scheduleScan(); return }

    for (const [id, path] of assigned) {
      const old = this.ids.get(id)
      const stat = present.get(path)!
      if (!old || old.path !== path) this.setId(id, { path, size: stat.size, mtimeMs: stat.mtimeMs }, true)
      else if (old.size !== stat.size || old.mtimeMs !== stat.mtimeMs) {
        this.setId(id, { path, size: stat.size, mtimeMs: stat.mtimeMs, hash: old.size === stat.size ? old.hash : undefined }, false)
      }
    }
    const currentIds = new Set(current.map(d => d.id))
    for (const id of candidates.keys()) {
      // Une entree que ce repertoire n'a jamais vue est peut-etre un ajout
      // d'une autre session dont le fichier n'est pas encore ecrit.
      if (initial || currentIds.has(id)) this.deleteId(id)
    }
    this.directory.applyFromDisk(assigned, folders)
    if (this.dirtyIds.size > 0 || this.deletedIds.size > 0) await this.saveIds()
  }

  /** Document disparu qui ressemble a ce nouveau fichier : meme taille et meme date, ou meme contenu. */
  private async matchRename(
    path: string,
    stat: { size?: number; mtimeMs?: number },
    candidates: Map<string, DocumentIdEntry>,
  ): Promise<string | undefined> {
    if (stat.size === undefined) return undefined
    const sameSize = [...candidates].filter(([, e]) => e.size === stat.size)
    const sameDate = sameSize.filter(([, e]) => e.mtimeMs !== undefined && e.mtimeMs === stat.mtimeMs)
    if (sameDate.length === 1) return sameDate[0][0]
    if (sameDate.length > 1) {
      const sameName = sameDate.filter(([, e]) => baseName(e.path) === baseName(path))
      if (sameName.length === 1) return sameName[0][0]
      return undefined
    }
    const hashed = sameSize.filter(([, e]) => e.hash)
    if (hashed.length === 0) return undefined
    const h = await contentHash(await this.fs.readBytes(path))
    const same = hashed.filter(([, e]) => e.hash === h)
    return same.length === 1 ? same[0][0] : undefined
  }

  private vaultGone(): void {
    if (this.gone) return
    this.gone = true
    this.unwatch?.()
    this.unwatch = null
    this.params.onConnectionChange?.('disconnected')
    this.params.onVaultGone?.()
  }

  // ── Evenements du disque ───────────────────────────────────────────────────

  private onDiskChanges(changes: FileChange[]): void {
    if (this.disposed || this.gone) return
    let rescan = false
    for (const change of changes) {
      const path = change.path
      if (path === SAVOIRE_DIR || path.startsWith(`${SAVOIRE_DIR}/`)) {
        if (this.onSavoireChange(change)) rescan = true
        continue
      }
      if (!isVaultPath(path)) continue
      if (change.kind !== 'modified') rescan = true
      if (change.kind !== 'deleted') this.onVisibleWrite(path)
    }
    if (rescan) this.scheduleScan()
  }

  /** Rend vrai si le dossier doit etre relu. */
  private onSavoireChange(change: FileChange): boolean {
    const path = change.path
    if (path === DOCUMENTS_PATH) {
      if (change.kind === 'deleted') return false
      this.background(async () => {
        const text = await this.fs.readText(DOCUMENTS_PATH).catch(() => this.lastIdsWritten)
        if (text !== this.lastIdsWritten) this.scheduleScan()
      })
      return false
    }
    if (path === VAULT_META_PATH || path === SAVOIRE_DIR) return change.kind === 'deleted'
    const slash = path.lastIndexOf('/')
    const dir = path.slice(0, slash)
    const name = path.slice(slash + 1)
    if (dir.startsWith(`${CRDT_DIR}/`) && change.kind === 'created' && UpdateLog.isLogFile(name)) {
      const owner = this.replicasByDir.get(dir)
      if (owner && !owner.replica.log.hasSeen(name)) this.background(() => this.pull(owner.replica))
    } else if (dir.startsWith(`${MAPS_DIR}/`) && change.kind === 'created' && UpdateLog.isLogFile(name)) {
      const owner = this.mapsByDir.get(dir)
      if (owner && !owner.log.hasSeen(name)) void owner.pull().catch(err => this.reportError(err))
    } else if (dir === DETACHED_DIR && change.kind !== 'deleted') {
      for (const docId of this.snapshotStates.keys()) {
        if (detachedPathOf(docId) === path && !this.directory.pathOf(docId)) this.background(() => this.checkSnapshot(docId))
      }
    }
    return false
  }

  /** Un fichier visible a ete ecrit (par nous ou par un autre outil). */
  private onVisibleWrite(path: string): void {
    const id = this.directory.idAt(path)
    if (!id) return
    this.forgetUrl(id)
    if (this.replicas.has(id) && this.isText(path)) this.background(() => this.ingest(id))
    if (this.snapshotStates.has(id)) this.background(() => this.checkSnapshot(id))
  }

  // ── Repliques CRDT ─────────────────────────────────────────────────────────

  private acquireReplica(docId: string): DocReplica {
    let replica = this.replicas.get(docId)
    if (!replica) {
      const doc = new Y_.Doc()
      const log = new UpdateLog(this.fs, crdtDirOf(docId), this.sessionId, {
        persistMs: this.persistMs,
        fullState: () => Y_.encodeStateAsUpdate(doc) as Uint8Array,
        onError: err => this.reportError(err),
      })
      const created: DocReplica = { doc, log, refs: 0, loaded: Promise.resolve(), projected: [] }
      replica = created
      doc.on('update', (update: Uint8Array, origin: unknown) => this.onReplicaUpdate(docId, created, update, origin))
      this.replicas.set(docId, created)
      this.replicasByDir.set(log.dir, { docId, replica: created })
      const previous = this.releasing.get(docId)
      created.loaded = this.enqueue(async () => {
        await previous
        await this.loadReplica(docId, created)
      })
    }
    replica.refs++
    return replica
  }

  private releaseReplica(docId: string, replica: DocReplica): void {
    replica.refs--
    if (replica.refs > 0 || this.replicas.get(docId) !== replica) return
    this.replicas.delete(docId)
    this.replicasByDir.delete(replica.log.dir)
    const timer = this.projectTimers.get(docId)
    const projectionPending = !!timer
    if (timer) { clearTimeout(timer); this.projectTimers.delete(docId) }
    let done: Promise<void> | undefined
    done = (async () => {
      try {
        await replica.loaded.catch(() => {})
        if (projectionPending) await this.enqueue(() => this.projectNow(docId, replica))
        await replica.log.compact(true)
      } catch (err) {
        this.reportError(err)
      } finally {
        replica.log.dispose()
        replica.doc.destroy()
        if (this.releasing.get(docId) === done) this.releasing.delete(docId)
      }
    })()
    this.releasing.set(docId, done)
  }

  private onReplicaUpdate(docId: string, replica: DocReplica, update: Uint8Array, origin: unknown): void {
    if (origin !== FROM_DISK) replica.log.append(update)
    if (origin === FROM_FILE || origin === FROM_SEED) void replica.log.flush().catch(err => this.reportError(err))
    if (origin === FROM_EDITOR || origin === FROM_MERGE) this.scheduleProjection(docId)
    const open = this.openDocs.get(docId)
    if (open && open.replica === replica && open.attached && origin !== FROM_EDITOR) open.crdt.applyRemoteOp(update)
  }

  /** Charge l'etat depuis `.savoire/`, puis le confronte au fichier visible. */
  private async loadReplica(docId: string, replica: DocReplica): Promise<void> {
    for (const u of await replica.log.readNew()) Y_.applyUpdate(replica.doc, u, FROM_DISK)
    const path = this.directory.pathOf(docId)
    if (path && this.isText(path)) await this.reconcileText(docId, replica, path)
  }

  private async pull(replica: DocReplica): Promise<void> {
    for (const u of await replica.log.readNew()) Y_.applyUpdate(replica.doc, u, FROM_DISK)
  }

  /** Le fichier visible d'un texte ouvert a change : relire l'etat, puis le fichier. */
  private async ingest(docId: string): Promise<void> {
    const replica = this.replicas.get(docId)
    const path = this.directory.pathOf(docId)
    if (!replica || !path || !this.isText(path)) return
    await this.pull(replica)
    await this.reconcileText(docId, replica, path)
  }

  /**
   * Confronte le texte CRDT au fichier visible :
   *   - aucun etat encore : le fichier donne le premier etat (vault Obsidian) ;
   *   - meme contenu, ou notre derniere ecriture : rien ;
   *   - une de nos projections passees (ecriture d'une autre session, ou
   *     interrompue) : on reecrit le fichier depuis l'etat ;
   *   - sinon c'est une modification faite ailleurs : diff minimal.
   */
  private async reconcileText(docId: string, replica: DocReplica, path: string): Promise<void> {
    let content: string
    try {
      content = await this.fs.readText(path)
    } catch {
      return
    }
    const text = ytextOf(replica.doc).toString()
    if (replica.log.isEmpty) {
      if (content) await this.applyDeterministic(docId, replica, content, 'seed')
      else replica.base = { text: '', state: Y_.encodeStateAsUpdate(replica.doc) }
      return
    }
    if (content === text) {
      replica.base = { text, state: Y_.encodeStateAsUpdate(replica.doc) }
      replica.staleFile = undefined
      return
    }
    if (replica.base && content === replica.base.text) return
    if (content === replica.staleFile || await this.isProjection(docId, replica, content)) {
      replica.base = undefined
      replica.staleFile = content
      this.scheduleProjection(docId)
      return
    }
    await this.applyDeterministic(docId, replica, content, 'edit')
  }

  /**
   * Amene le texte de la replique a `content`, par un client Yjs
   * DETERMINISTE : deux sessions au meme etat qui voient le meme fichier
   * produisent la meme mise a jour, que Yjs ne compte qu'une fois.
   */
  private async applyDeterministic(docId: string, replica: DocReplica, content: string, kind: 'seed' | 'edit'): Promise<void> {
    // Depuis le dernier accord fichier/CRDT ; a defaut, depuis l'etat courant.
    const baseState = replica.base?.state ?? (Y_.encodeStateAsUpdate(replica.doc) as Uint8Array)
    const sv = Y_.encodeStateVectorFromUpdate(baseState) as Uint8Array
    const temp = new Y_.Doc()
    temp.clientID = await deterministicClientId(`${kind}:${docId}:${bytesToBase64(sv)}:${await contentHash(content)}`)
    Y_.applyUpdate(temp, baseState)
    const ytext = ytextOf(temp)
    const edits = diffText(ytext.toString(), content)
    temp.transact(() => {
      let pos = 0
      for (const e of edits) {
        if ('retain' in e) pos += e.retain
        else if ('delete' in e) ytext.delete(pos, e.delete)
        else { ytext.insert(pos, e.insert); pos += e.insert.length }
      }
    })
    const update = Y_.encodeStateAsUpdate(temp, sv) as Uint8Array
    replica.base = { text: content, state: Y_.encodeStateAsUpdate(temp) as Uint8Array }
    replica.staleFile = undefined
    temp.destroy()
    Y_.applyUpdate(replica.doc, update, kind === 'seed' ? FROM_SEED : FROM_FILE)
    await replica.log.flush()
    await this.rememberHash(docId, content)
  }

  // ── Projection du texte dans le fichier visible ────────────────────────────

  private scheduleProjection(docId: string): void {
    if (this.disposed && !this.replicas.has(docId)) return
    const path = this.directory.pathOf(docId)
    if (!path || !this.isText(path)) return
    const old = this.projectTimers.get(docId)
    if (old) clearTimeout(old)
    this.projectTimers.set(docId, setTimeout(() => {
      this.projectTimers.delete(docId)
      this.background(() => this.projectNow(docId))
    }, this.projectMs))
  }

  /** Ecrit le texte dans le fichier visible, s'il a change. */
  private async projectNow(docId: string, replica = this.replicas.get(docId)): Promise<void> {
    if (!replica) return
    const path = this.directory.pathOf(docId)
    if (!path || !this.isText(path)) return
    // Supprime ou deplace ailleurs entre-temps : la relecture du dossier tranchera.
    if (!(await this.fs.exists(path))) return
    if (!replica.base) {
      // Fichier jamais confronte a l'etat : on le lit avant de l'ecraser. Une
      // projection perimee ou un fichier tout juste cree se reecrivent ; un
      // autre contenu est une modification externe, fusionnee d'abord.
      const content = await this.fs.readText(path)
      const known = content === replica.staleFile || content === '' || await this.isProjection(docId, replica, content)
      if (!known) await this.reconcileText(docId, replica, path)
    }
    const text = ytextOf(replica.doc).toString()
    if (text === replica.base?.text) return
    const state = Y_.encodeStateAsUpdate(replica.doc) as Uint8Array
    // Les mises a jour d'abord : une autre session les lit avant de comparer le fichier.
    await replica.log.flush()
    await this.rememberProjection(docId, replica, text)
    await this.fs.writeText(path, text)
    replica.base = { text, state }
    replica.staleFile = undefined
    await this.refreshMeta(docId, path, await contentHash(text))
  }

  /** Texte deja dote d'un etat (sans chemin jusqu'ici) : son fichier visible le montre. */
  private async projectFromState(docId: string): Promise<void> {
    const loaded = this.replicas.get(docId)
    if (loaded) { this.scheduleProjection(docId); return }
    const dir = crdtDirOf(docId)
    if (!(await this.fs.exists(dir)) || (await this.fs.list(dir)).length === 0) return
    // Charge sans passer par la file (on y est deja) : etat seul, puis ecriture.
    const doc = new Y_.Doc()
    const log = new UpdateLog(this.fs, dir, this.sessionId, {
      persistMs: this.persistMs, fullState: () => new Uint8Array(), onError: err => this.reportError(err),
    })
    try {
      for (const u of await log.readNew()) Y_.applyUpdate(doc, u)
      const text = ytextOf(doc).toString()
      const path = this.directory.pathOf(docId)
      if (!text || !path) return
      const current = await this.fs.readText(path).catch(() => null)
      if (current !== '') return
      await this.rememberProjection(docId, null, text)
      await this.fs.writeText(path, text)
      await this.refreshMeta(docId, path, await contentHash(text))
    } finally {
      log.dispose()
      doc.destroy()
    }
  }

  private projectionsPath(docId: string): string {
    return `${crdtDirOf(docId)}/projected.json`
  }

  /** Note l'empreinte d'un texte qu'on va ecrire (lue par les autres sessions). */
  private async rememberProjection(docId: string, replica: DocReplica | null, text: string): Promise<void> {
    const h = await contentHash(text)
    if (replica) replica.projected = [...replica.projected.filter(x => x !== h), h].slice(-PROJECTIONS_KEPT)
    const file = this.projectionsPath(docId)
    let hashes: string[] = []
    try { hashes = (JSON.parse(await this.fs.readText(file)) as { hashes?: string[] }).hashes ?? [] } catch { /* premier */ }
    hashes = [...hashes.filter(x => x !== h), h].slice(-PROJECTIONS_KEPT)
    await this.fs.writeText(file, JSON.stringify({ hashes }))
  }

  /** Ce contenu est-il une projection recente (de cette session ou d'une autre) ? */
  private async isProjection(docId: string, replica: DocReplica, content: string): Promise<boolean> {
    const h = await contentHash(content)
    if (replica.projected.includes(h)) return true
    try {
      const { hashes } = JSON.parse(await this.fs.readText(this.projectionsPath(docId))) as { hashes?: string[] }
      return !!hashes?.includes(h)
    } catch {
      return false
    }
  }

  // ── Snapshots ──────────────────────────────────────────────────────────────

  /** Ou vit le contenu d'un document snapshot : son fichier, ou `.savoire/detached/` sans chemin. */
  private snapshotTarget(docId: string): string {
    return this.directory.pathOf(docId) ?? detachedPathOf(docId)
  }

  private snapshotChannel(docId: string): SnapshotChannel {
    const state: SnapshotState = { listeners: new Set() }
    this.snapshotStates.set(docId, state)
    const initial = this.enqueue(async () => {
      const target = this.snapshotTarget(docId)
      const content = (await this.fs.exists(target)) ? await this.fs.readText(target) : ''
      state.lastDisk = content
      // Un fichier vide n'a jamais ete ecrit (fichier cree a l'ajout du document).
      return content === '' ? null : content
    })
    return {
      initial,
      push: content => this.enqueue(async () => {
        const target = this.snapshotTarget(docId)
        const hash = await contentHash(content)
        const meta: SnapshotMeta = { userId: this.params.userId, session: this.sessionId, hash }
        await this.fs.writeText(snapshotMetaOf(docId), JSON.stringify(meta))
        await this.fs.writeText(target, content)
        state.lastDisk = content
        if (target !== detachedPathOf(docId)) await this.refreshMeta(docId, target, hash)
      }),
      onRemote: cb => { state.listeners.add(cb); return () => { state.listeners.delete(cb) } },
      // Pas de pairs en ligne : la presence ne va nulle part.
      pushPresence: async () => {},
      onPresence: () => () => {},
      close: () => { if (this.snapshotStates.get(docId) === state) this.snapshotStates.delete(docId) },
    }
  }

  /** Le fichier d'un snapshot ouvert a change : si ce n'est pas nous, on previent la vue. */
  private async checkSnapshot(docId: string): Promise<void> {
    const state = this.snapshotStates.get(docId)
    if (!state) return
    const target = this.snapshotTarget(docId)
    if (!(await this.fs.exists(target))) return
    const content = await this.fs.readText(target)
    if (content === state.lastDisk) return
    state.lastDisk = content
    let from = EXTERNAL_WRITER_ID
    try {
      const meta = JSON.parse(await this.fs.readText(snapshotMetaOf(docId))) as SnapshotMeta
      if (meta.hash === (await contentHash(content))) {
        if (meta.session === this.sessionId) return
        from = meta.userId
      }
    } catch { /* aucune trace : ecrit par un autre outil */ }
    for (const cb of [...state.listeners]) cb(content, from)
  }

  // ── Fichiers (pieces jointes) ──────────────────────────────────────────────

  /**
   * Fichier d'une piece jointe : son chemin lisible (comme Obsidian), ou
   * `.savoire/detached/<id>` tant qu'il n'est pas au repertoire. Accepte aussi
   * un chemin, ou un ancien nom de stockage sous `attachments/`.
   */
  private async fileTarget(fileId: string): Promise<string | null> {
    const path = this.directory.pathOf(fileId)
    const candidates = [path, detachedPathOf(fileId)]
    if (isVaultPath(fileId)) candidates.push(fileId, `attachments/${fileId}`)
    for (const c of candidates) {
      if (!c) continue
      const st = await this.fs.stat(c)
      if (st?.kind === 'file') return c
    }
    return null
  }

  private async uploadFile(fileId: string, file: Blob): Promise<void> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (file.type) this.uploadTypes.set(fileId, file.type)
    await this.enqueue(async () => {
      const path = this.directory.pathOf(fileId)
      if (path) {
        await this.fs.writeBytes(path, bytes)
        await this.refreshMeta(fileId, path)
      } else {
        // Sans chemin, rien ne dit le type : il est note a cote.
        const detached = detachedPathOf(fileId)
        await this.fs.writeText(`${detached}.json`, JSON.stringify({ type: file.type || 'application/octet-stream' }))
        await this.fs.writeBytes(detached, bytes)
      }
    })
    this.forgetUrl(fileId)
  }

  private readFileBytes(fileId: string): Promise<{ bytes: Uint8Array; type: string }> {
    return this.enqueue(async () => {
      const target = await this.fileTarget(fileId)
      if (!target) throw new Error(`fichier introuvable dans le vault : ${fileId}`)
      return { bytes: await this.fs.readBytes(target), type: await this.typeOf(fileId, target) }
    })
  }

  private fileUrl(fileId: string): Promise<string> {
    return this.enqueue(async () => {
      const target = await this.fileTarget(fileId)
      if (!target) throw new Error(`fichier introuvable dans le vault : ${fileId}`)
      const st = await this.fs.stat(target)
      const cached = this.urlCache.get(fileId)
      if (cached && cached.path === target && cached.mtimeMs === st?.mtimeMs) return cached.url
      const bytes = await this.fs.readBytes(target)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: await this.typeOf(fileId, target) }))
      if (cached) URL.revokeObjectURL(cached.url)
      this.urlCache.set(fileId, { url, path: target, mtimeMs: st?.mtimeMs })
      return url
    })
  }

  private async typeOf(fileId: string, target: string): Promise<string> {
    const byPath = mimeTypeOf(this.directory.pathOf(fileId) ?? target)
    if (byPath !== 'application/octet-stream') return byPath
    const known = this.uploadTypes.get(fileId)
    if (known) return known
    if (target === detachedPathOf(fileId)) {
      try {
        return (JSON.parse(await this.fs.readText(`${target}.json`)) as { type?: string }).type ?? byPath
      } catch { /* type inconnu */ }
    }
    return byPath
  }

  /** Le fichier a bouge ou change : la prochaine URL sera neuve. L'ancienne reste valide pour l'image affichee. */
  private forgetUrl(fileId: string): void {
    const cached = this.urlCache.get(fileId)
    if (cached) cached.mtimeMs = -1
  }

  // ── Ids stables (`.savoire/documents.json`) ────────────────────────────────

  private setId(id: string, entry: DocumentIdEntry, structural: boolean): void {
    this.ids.set(id, entry)
    this.deletedIds.delete(id)
    this.dirtyIds.add(id)
    if (!structural) this.scheduleIdsSave()
  }

  private deleteId(id: string): void {
    this.ids.delete(id)
    this.dirtyIds.delete(id)
    this.deletedIds.add(id)
  }

  private async refreshMeta(id: string, path: string, hash?: string): Promise<void> {
    const st = await this.fs.stat(path)
    const old = this.ids.get(id)
    if (!st || !old || old.path !== path) return
    this.setId(id, { path, size: st.size, mtimeMs: st.mtimeMs, hash: hash ?? (old.size === st.size ? old.hash : undefined) }, false)
  }

  private async rememberHash(id: string, content: string): Promise<void> {
    const path = this.directory.pathOf(id)
    if (path) await this.refreshMeta(id, path, await contentHash(content))
  }

  private scheduleIdsSave(): void {
    if (this.idsTimer || this.disposed) return
    this.idsTimer = setTimeout(() => {
      this.idsTimer = null
      this.background(() => this.saveIds())
    }, 1000)
  }

  /** Relit `.savoire/documents.json` et y ajoute nos changements pas encore ecrits. */
  private async loadIds(): Promise<void> {
    let disk: Record<string, DocumentIdEntry> = {}
    let diskFolders: string[] = []
    try {
      if (await this.fs.exists(DOCUMENTS_PATH)) {
        const file = JSON.parse(await this.fs.readText(DOCUMENTS_PATH)) as DocumentsFile
        disk = file.documents ?? {}
        diskFolders = file.folders ?? []
      }
    } catch (err) {
      this.reportError(err)
    }
    const folders = new Set(diskFolders)
    for (const f of this.removedFolders) folders.delete(f)
    for (const f of this.addedFolders) folders.add(f)
    this.explicitFolders = folders
    const merged = new Map<string, DocumentIdEntry>(Object.entries(disk))
    for (const id of this.deletedIds) merged.delete(id)
    for (const id of this.dirtyIds) {
      const e = this.ids.get(id)
      if (e) merged.set(id, e)
    }
    this.ids = merged
  }

  /** Ecrit les ids, fusionnes avec ce qu'une autre session a pu ecrire entre-temps. */
  private async saveIds(force = false): Promise<void> {
    if (!force && this.dirtyIds.size === 0 && this.deletedIds.size === 0) return
    await this.loadIds()
    this.dirtyIds.clear()
    this.deletedIds.clear()
    this.addedFolders.clear()
    this.removedFolders.clear()
    const documents: Record<string, DocumentIdEntry> = {}
    for (const [id, e] of [...this.ids].sort((a, b) => a[1].path.localeCompare(b[1].path))) documents[id] = e
    const file: DocumentsFile = { format: VAULT_FORMAT_VERSION, documents, folders: [...this.explicitFolders].sort() }
    const text = `${JSON.stringify(file, null, 2)}\n`
    this.lastIdsWritten = text
    await this.fs.writeText(DOCUMENTS_PATH, text)
  }
}

/**
 * Fabrique des sessions sur disque. `resolveFileSystem` donne le dossier d'un
 * vault (l'application garde la correspondance vault -> dossier).
 */
export class FileSystemVaultSessionFactory implements IVaultSyncSessionFactory {
  constructor(
    private readonly resolveFileSystem: (vaultId: string) => IVaultFileSystem | Promise<IVaultFileSystem>,
    private readonly options: FileSystemVaultSessionOptions = {},
  ) {}

  async open(params: VaultSyncSessionFactoryParams): Promise<IVaultSyncSession> {
    const fs = await this.resolveFileSystem(params.vaultId)
    return FileSystemVaultSession.open(fs, params, this.options)
  }
}
