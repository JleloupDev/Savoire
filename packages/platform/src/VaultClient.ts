// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * VaultClient — abstraction du stockage de fichiers vault.
 *
 * readDocumentByPath(path) :
 *   1. Si le chemin correspond à un document connu → DocumentStore.readContent()
 *      (cache-first, endpoint /documents/{id}/content — masque sync/pas-sync)
 *   2. Sinon → IVaultStorage.readFile() (attachments : images, PDF…)
 *
 * Les plugins ![[...]] et @[[...]] ne savent rien de cette logique.
 *
 * Avec une session de vault (cas normal), TOUT le contenu passe par elle :
 * lecture des documents, ecriture des documents snapshot, pieces jointes. La
 * session est le seul endroit qui parle au reseau, quel que soit le profil
 * (serveur Savoire, pair a pair). Sans session (document partage isole), les
 * anciens chemins `documentStore` / `storage` restent utilises.
 */
import type { AttachmentUploadOptions, TrashEntry, VaultAPI } from '@savoire/plugin-api'
import { documentSyncKind, type DocumentSyncKind, type IDocumentMeta, type IVaultContentSession, type IVaultDirectory, type IVaultStorage } from './ports'
import {
  ATTACHMENTS_DIR, attachmentFolderFor, folderNoteOf, isAttachmentPath, linkTargetFor, resolveLinkPath, uniqueAttachmentPath,
} from './attachments'
import { uploadTracker, type UploadTracker } from './uploads'
import { isTrashPath, originalPathOf, restorePathFor, trashPathFor } from './trash'
import type { DocumentStore } from './DocumentStore'

export class VaultClient implements VaultAPI {
  constructor(
    private readonly vaultId: string,
    private token: string,
    private readonly storage: IVaultStorage,
    private readonly documentStore: DocumentStore,
    private readonly directory: IVaultDirectory,
    /** Résout un chemin relatif en IDocumentMeta — fourni par l'app layer. */
    private readonly resolveDoc: (path: string) => IDocumentMeta | undefined,
    /** Session du vault. Absente pour un document partage isole. */
    private readonly session?: IVaultContentSession,
    /** Famille de synchro d'un document. Defaut : seul le Markdown est un CRDT. */
    private readonly syncKindOf: (path: string) => DocumentSyncKind = documentSyncKind,
    /** Ou annoncer les envois (progression, succes, echec). */
    private readonly uploads: UploadTracker = uploadTracker,
  ) {}

  /** Met à jour le token Bearer (appelé après refresh du token d'accès). */
  setToken(token: string): void {
    this.token = token
  }

  // ── Directory management ──────────────────────────────────────────────────


  addDocument(doc: IDocumentMeta): void {
    this.directory.add(doc)
  }

  removeDocument(id: string): void {
    this.directory.remove(id)
  }

  renameDocumentInCache(id: string, newPath: string): void {
    this.directory.rename(id, newPath)
  }

  /** Subscribe to document list changes — returns unsubscribe function. */
  onChange(cb: () => void): () => void {
    return this.directory.onChange(cb)
  }

  /**
   * Documents du vault, HORS corbeille : c'est la liste que voient l'ouverture
   * rapide, les agents, la resolution des liens. La corbeille se lit par
   * listTrash().
   */
  get documents(): readonly IDocumentMeta[] {
    return this.directory.getAll().filter(d => !isTrashPath(d.path))
  }

  // ── CRDT sync (wired by VaultHubClient when the server supports binary ops) ──

  applyVaultUpdate(update: Uint8Array): void {
    this.directory.applyUpdate(update)
  }

  encodeVaultState(): Uint8Array {
    return this.directory.encodeFullState()
  }

  onLocalVaultUpdate(cb: (update: Uint8Array) => void): () => void {
    return this.directory.onLocalUpdate(cb)
  }

  // ── VaultAPI ──────────────────────────────────────────────────────────────

  async read(documentId: string): Promise<string> {
    const meta = this.directory.getById(documentId)
    if (this.session && meta) return this.session.readDocument(documentId, this.syncKindOf(meta.path))
    return this.documentStore.readContent(this.vaultId, documentId, this.token, meta)
  }

  async readDocumentByPath(path: string): Promise<string> {
    const doc = this._resolveDocumentByPath(path)
    if (this.session) {
      // Une piece jointe est inscrite au repertoire, mais son contenu est un fichier.
      if (path.startsWith(ATTACHMENTS_DIR) || isAttachmentPath(path) || !doc) {
        const files = this.session.files
        return this.withAttachment(path, key => files.read(key))
      }
      return this.session.readDocument(doc.id, this.syncKindOf(doc.path))
    }
    if (doc) {
      const ext = path.split('.').at(-1) ?? ''
      if (ext !== 'md') return this.documentStore.readDirect(this.vaultId, doc.id, this.token)
      return this.documentStore.readContent(this.vaultId, doc.id, this.token, doc)
    }
    // Fallback : attachments (images, PDFs, fichiers non-.md)
    return this.storage.readFile(this.vaultId, path, this.token)
  }

  async write(documentId: string, content: string): Promise<void> {
    const meta = this.directory.getById(documentId)
    if (!meta) throw new Error(`Document not found: ${documentId}`)
    if (this.session && this.syncKindOf(meta.path) === 'snapshot') {
      // Ouverture courte : si une vue tient deja le document, on partage sa
      // synchro ; sinon on l'ouvre le temps d'ecrire.
      const doc = this.session.openSnapshot(documentId)
      try {
        await doc.load()
        await doc.write(content)
      } finally {
        this.session.closeSnapshot(documentId)
      }
      return
    }
    // Un document CRDT s'ecrit par ses operations (l'editeur), jamais en bloc.
    await this.documentStore.writeContent(this.vaultId, documentId, content, this.token)
  }

  // see ADR-010
  async list(dir?: string): Promise<string[]> {
    const prefix = !dir ? '' : dir.endsWith('/') ? dir : dir + '/'
    // La corbeille n'apparait que si on la demande : list('.trash/').
    const hideTrash = !isTrashPath(prefix)
    const result = new Set<string>()
    for (const doc of this.directory.getAll()) {
      if (!doc.path.startsWith(prefix)) continue
      if (hideTrash && isTrashPath(doc.path)) continue
      const rest = doc.path.slice(prefix.length)
      const slashIdx = rest.indexOf('/')
      if (slashIdx === -1) result.add(prefix + rest)
      else result.add(prefix + rest.slice(0, slashIdx) + '/')
    }
    for (const folderPath of this.directory.getFolders()) {
      if (!folderPath.startsWith(prefix)) continue
      const rest = folderPath.slice(prefix.length)
      if (!rest) continue
      const slashIdx = rest.indexOf('/')
      result.add(slashIdx === -1 ? prefix + rest : prefix + rest.slice(0, slashIdx) + '/')
    }
    return Array.from(result).sort()
  }

  async exists(documentId: string): Promise<boolean> {
    try { await this.read(documentId); return true } catch { return false }
  }

  resolveDocumentId(path: string): string | undefined {
    return this._resolveDocumentByPath(path)?.id
  }

  getVaultId(): string {
    return this.vaultId
  }

  getToken(): string {
    return this.token
  }

  async createFile(path: string): Promise<void> {
    const normalizedPath = path.includes('.') ? path : `${path}.md`
    if (this._findDocumentByPath(path) || this._findDocumentByPath(normalizedPath)) return

    // Documents are CRDT-only: adding to the directory emits a local vault op
    // that the hub pushes to the server and relays to peers. No REST round-trip.
    // Mais le document est d'abord inscrit aupres de la session : en mode
    // serveur, un document inconnu du registre serait refuse.
    const id = crypto.randomUUID()
    await this.session?.registerDocuments([id])
    this.addDocument({ id, path: normalizedPath })
  }

  async createFolder(path: string): Promise<void> {
    // Folders are CRDT state: adding one emits a local vault op (pushed by the
    // hub and merged peer-to-peer), exactly like documents. No REST round-trip.
    const normalized = path.endsWith('/') ? path : path + '/'
    this.directory.addFolder(normalized)
  }

  async renameFile(documentId: string, newPath: string): Promise<void> {
    await this.renameDocument(documentId, newPath)
  }

  /**
   * Supprimer = mettre a la corbeille. Tous les appelants (arborescence,
   * notes de dossier, plugins) passent par ici. Un document deja dans la
   * corbeille n'y bouge pas : l'effacer est deleteFilePermanently.
   */
  async deleteFile(documentId: string): Promise<void> {
    this.trash(documentId)
  }

  /**
   * Met a la corbeille les documents du dossier (toute profondeur), puis
   * retire le dossier et ses sous-dossiers du repertoire CRDT. Un dossier
   * deja vide (apres un deplacement) ne fait que perdre ses entrees.
   */
  async deleteFolder(path: string): Promise<void> {
    const prefix = path.endsWith('/') ? path : path + '/'
    for (const doc of this.directory.getAll()) {
      if (doc.path.startsWith(prefix)) this.trash(doc.id)
    }
    for (const f of this.directory.getFolders()) {
      if (f === prefix || f.startsWith(prefix)) this.directory.removeFolder(f)
    }
  }

  // ── Corbeille ─────────────────────────────────────────────────────────────

  /**
   * Met un document a la corbeille : simple renommage sous `.trash/` dans le
   * repertoire CRDT, chemin d'origine conserve (suffixe en cas de collision).
   * Les octets d'une piece jointe restent stockes. Rend le nouveau chemin.
   */
  trash(documentId: string): string | undefined {
    const meta = this.directory.getById(documentId)
    if (!meta) return undefined
    if (isTrashPath(meta.path)) return meta.path
    const target = trashPathFor(meta.path, p => !!this._findDocumentByPath(p))
    this.renameDocumentInCache(documentId, target)
    return target
  }

  listTrash(): TrashEntry[] {
    return this.directory.getAll()
      .filter(d => isTrashPath(d.path))
      .map(d => ({ documentId: d.id, path: d.path, originalPath: originalPathOf(d.path) }))
      .sort((a, b) => a.originalPath.localeCompare(b.originalPath))
  }

  isTrashed(documentId: string): boolean {
    const meta = this.directory.getById(documentId)
    return !!meta && isTrashPath(meta.path)
  }

  async restoreFromTrash(documentId: string): Promise<string> {
    const meta = this.directory.getById(documentId)
    if (!meta) throw new Error(`Document not found: ${documentId}`)
    if (!isTrashPath(meta.path)) return meta.path
    const target = restorePathFor(meta.path, p => !!this._findDocumentByPath(p))
    this.renameDocumentInCache(documentId, target)
    return target
  }

  /**
   * Efface un document de la corbeille : il quitte le repertoire. Les octets
   * d'une piece jointe ne sont pas encore effaces du stockage.
   */
  async deleteFilePermanently(documentId: string): Promise<void> {
    const meta = this.directory.getById(documentId)
    if (!meta) return
    if (!isTrashPath(meta.path)) throw new Error('Seul un document de la corbeille peut etre supprime definitivement.')
    this.removeDocument(documentId)
  }

  /**
   * Envoie une piece jointe sous son nom d'origine (« Nom 1.png » si
   * « Nom.png » est pris). Depuis une note (`notePath`), elle va dans le
   * dossier de la note (ATTACHMENT_LOCATION, attachments.ts) ; sinon dans
   * `attachments/`. Les octets sont ranges sous l'id du document : le nom
   * reste renommable. L'envoi est annonce (progression, succes, echec) au
   * suivi des envois. Rend le chemin du document cree.
   */
  async uploadAttachment(file: File, options: AttachmentUploadOptions = {}): Promise<string> {
    const report = this.uploads.begin(file.name)
    try {
      const path = await this.storeAttachment(file, options.notePath, f => report.progress(f))
      report.done(path)
      return path
    } catch (err) {
      report.fail(err)
      throw err
    }
  }

  private async storeAttachment(file: File, notePath: string | undefined, onProgress: (f: number) => void): Promise<string> {
    if (!this.session) {
      // Document partage isole : ancien chemin, nom genere par le serveur.
      const { storagePath } = await this.storage.uploadAttachment(this.vaultId, file, this.token)
      return `${ATTACHMENTS_DIR}${storagePath}`
    }
    const folder = attachmentFolderFor(notePath)
    const path = uniqueAttachmentPath(file.name, p => !!this._findDocumentByPath(p), folder)
    const id = crypto.randomUUID()
    await this.session.registerDocuments([id])
    await this.session.files.upload(id, file, { onProgress })
    // Le document n'apparait qu'une fois les octets en place.
    this.addDocument({ id, path })
    // Rangee avec sa note : on l'annonce (partage de la note). Un echec ne
    // gache pas l'envoi, l'image est la ; seul le partage ne la verra pas.
    const noteId = notePath && folder !== ATTACHMENTS_DIR ? this._findDocumentByPath(notePath)?.id : undefined
    if (noteId) void this.announcePlacement(id, noteId, path)
    return path
  }

  // ── Rangement des pieces jointes (partage d'une note) ─────────────────────

  private readonly placementsToAnnounce = new Set<string>()
  private placementTimer: ReturnType<typeof setTimeout> | null = null

  private async announcePlacement(fileId: string, noteId: string | null, path: string): Promise<void> {
    const place = this.session?.files.place
    if (!place) return
    try {
      await place.call(this.session!.files, fileId, { noteId, name: path.slice(path.lastIndexOf('/') + 1) })
    } catch (err) {
      console.warn('[VaultClient] rangement de la piece jointe non annonce', fileId, err)
    }
  }

  /**
   * Une piece jointe a bouge : on annonce sa nouvelle note un peu plus tard.
   * Deplacer une note de dossier renomme d'abord son contenu, puis la note :
   * on attend la fin du mouvement pour trouver la note du nouveau dossier.
   */
  private schedulePlacement(fileId: string): void {
    if (!this.session?.files.place) return
    this.placementsToAnnounce.add(fileId)
    if (this.placementTimer) clearTimeout(this.placementTimer)
    this.placementTimer = setTimeout(() => void this.flushPlacements(), 300)
  }

  /** Annonce le rangement des pieces jointes deplacees. Rend quand c'est fait (tests). */
  async flushPlacements(): Promise<void> {
    if (this.placementTimer) { clearTimeout(this.placementTimer); this.placementTimer = null }
    const ids = [...this.placementsToAnnounce]
    this.placementsToAnnounce.clear()
    const all = this.directory.getAll()
    const paths = all.map(d => d.path)
    await Promise.all(ids.map(async id => {
      const meta = this.directory.getById(id)
      // Une image a la corbeille garde son rangement : la restaurer le retrouve.
      if (!meta || isTrashPath(meta.path)) return
      const folder = meta.path.slice(0, meta.path.lastIndexOf('/') + 1)
      const notePath = folder ? folderNoteOf(folder, paths) : undefined
      const noteId = notePath ? all.find(d => d.path === notePath)?.id ?? null : null
      await this.announcePlacement(id, noteId, meta.path)
    }))
  }

  /** Texte a mettre dans `![[...]]` : le nom seul s'il est unique, sinon le chemin. */
  linkTarget(path: string): string {
    return linkTargetFor(path, this.documents.map(d => d.path))
  }

  /** URL affichable d'une piece jointe, designee par son chemin ou son seul nom. */
  async resolveAttachmentUrl(path: string): Promise<string> {
    if (this.session) {
      const files = this.session.files
      return this.withAttachment(path, key => files.url(key))
    }
    const doc = this.resolveLinkDocument(path)
    return this.storage.resolveFileUrl(this.vaultId, attachmentStoragePath(doc?.path ?? path))
  }

  /**
   * Applique `op` a la piece jointe designee par `target` : d'abord sous l'id
   * de son document, puis sous son ancien nom de stockage (pieces jointes
   * d'avant le rangement par id, nommees `attachments/<guid>.png`).
   */
  private async withAttachment<T>(target: string, op: (key: string) => Promise<T>): Promise<T> {
    const doc = this.resolveLinkDocument(target)
    if (!doc) return op(attachmentStoragePath(target))
    try {
      return await op(doc.id)
    } catch (err) {
      const legacy = attachmentStoragePath(doc.path)
      if (legacy === doc.path || legacy.includes('/')) throw err
      return op(legacy)
    }
  }

  /** Document vise par un lien : chemin exact, ou resolution par nom (Obsidian). */
  private resolveLinkDocument(target: string): IDocumentMeta | undefined {
    const exact = this._findDocumentByPath(target)
    if (exact) return exact
    // La corbeille ne repond pas aux liens par nom (comme Obsidian).
    const all = this.documents
    const path = resolveLinkPath(target, all.map(d => d.path))
    return path ? all.find(d => d.path === path) : undefined
  }

  async renameDocument(documentId: string, newPath: string): Promise<void> {
    const normalizedNewPath = newPath.includes('.') ? newPath : `${newPath}.md`
    this.renameDocumentInCache(documentId, normalizedNewPath)
    if (isAttachmentPath(normalizedNewPath)) this.schedulePlacement(documentId)
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.removeDocument(documentId)
  }

  private _resolveDocumentByPath(path: string): IDocumentMeta | undefined {
    const normalizedPath = path.includes('.') ? path : `${path}.md`
    // Check directory first, then fall back to external resolver
    for (const doc of this.directory.getAll()) {
      if (doc.path === path || doc.path === normalizedPath) return doc
    }
    return this.resolveDoc(path) ?? this.resolveDoc(normalizedPath)
  }

  private _findDocumentByPath(path: string): IDocumentMeta | undefined {
    for (const doc of this.directory.getAll()) {
      if (doc.path === path) return doc
    }
    return undefined
  }
}

/** Chemin de stockage d'une piece jointe : son chemin sans le prefixe `attachments/`. */
function attachmentStoragePath(path: string): string {
  return path.startsWith(ATTACHMENTS_DIR) ? path.slice(ATTACHMENTS_DIR.length) : path
}
