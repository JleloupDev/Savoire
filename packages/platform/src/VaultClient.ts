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
 */
import type { VaultAPI } from '@savoire/plugin-api'
import type { IDocumentMeta, IVaultStorage } from './ports'
import type { DocumentStore } from './DocumentStore'

export class VaultClient implements VaultAPI {
  // see ADR-010
  private readonly _documentsById = new Map<string, IDocumentMeta>()
  // see ADR-010
  private readonly _explicitFolders = new Set<string>()
  private _onChangeCallbacks: (() => void)[] = []
  private _pendingFileCreates = new Map<string, Promise<void>>()

  constructor(
    private readonly vaultId: string,
    private token: string,
    private readonly storage: IVaultStorage,
    private readonly documentStore: DocumentStore,
    /** Résout un chemin relatif en IDocumentMeta — fourni par l'app layer. */
    private readonly resolveDoc: (path: string) => IDocumentMeta | undefined,
  ) {}

  /** Met à jour le token Bearer (appelé après refresh du token d'accès). */
  setToken(token: string): void {
    this.token = token
  }

  // ── Cache management (called by VaultHubClient or after REST mutations) ──

  /** Replace the entire cache — called on VaultHub snapshot. */
  setSnapshot(docs: IDocumentMeta[]): void {
    this._documentsById.clear()
    for (const doc of docs) this._documentsById.set(doc.id, doc)
    this._notifyChange()
  }

  /** Add a document to the cache (optimistic or from hub event). */
  addDocument(doc: IDocumentMeta): void {
    // Deduplicate: if doc already exists, skip
    if (this._documentsById.has(doc.id)) return
    this._documentsById.set(doc.id, doc)
    this._notifyChange()
  }

  /** Remove a document from the cache by id. */
  removeDocument(id: string): void {
    if (this._documentsById.delete(id)) this._notifyChange()
  }

  /** Rename a document in the cache. */
  renameDocumentInCache(id: string, newPath: string): void {
    const doc = this._documentsById.get(id)
    if (!doc) return
    this._documentsById.set(id, { ...doc, path: newPath })
    this._notifyChange()
  }

  /** Subscribe to cache changes — returns unsubscribe function. */
  onChange(cb: () => void): () => void {
    this._onChangeCallbacks.push(cb)
    return () => {
      this._onChangeCallbacks = this._onChangeCallbacks.filter(c => c !== cb)
    }
  }

  /** Get current cached documents. */
  get documents(): readonly IDocumentMeta[] {
    return Array.from(this._documentsById.values())
  }

  private _notifyChange(): void {
    for (const cb of this._onChangeCallbacks) cb()
  }

  async read(documentId: string): Promise<string> {
    const meta = this._documentsById.get(documentId)
    return this.documentStore.readContent(this.vaultId, documentId, this.token, meta)
  }

  async readDocumentByPath(path: string): Promise<string> {
    const doc = this._resolveDocumentByPath(path)
    if (doc) {
      const ext = path.split('.').at(-1) ?? ''
      if (ext !== 'md') return this.documentStore.readDirect(this.vaultId, doc.id, this.token)
      return this.documentStore.readContent(this.vaultId, doc.id, this.token, doc)
    }
    // Fallback : attachments (images, PDFs, fichiers non-.md)
    return this.storage.readFile(this.vaultId, path, this.token)
  }

  async write(documentId: string, content: string): Promise<void> {
    const doc = this._documentsById.get(documentId)
    if (!doc) throw new Error(`Document not found: ${documentId}`)
    await this.documentStore.writeContent(this.vaultId, documentId, content, this.token)
  }

  // see ADR-010
  async list(dir?: string): Promise<string[]> {
    const prefix = !dir ? '' : dir.endsWith('/') ? dir : dir + '/'
    const result = new Set<string>()
    for (const doc of this._documentsById.values()) {
      if (!doc.path.startsWith(prefix)) continue
      const rest = doc.path.slice(prefix.length)
      const slashIdx = rest.indexOf('/')
      if (slashIdx === -1) result.add(prefix + rest)
      else result.add(prefix + rest.slice(0, slashIdx) + '/')
    }
    for (const folderPath of this._explicitFolders) {
      if (!folderPath.startsWith(prefix)) continue
      const rest = folderPath.slice(prefix.length)
      if (!rest) continue
      const slashIdx = rest.indexOf('/')
      result.add(slashIdx === -1 ? prefix + rest : prefix + rest.slice(0, slashIdx) + '/')
    }
    return Array.from(result).sort()
  }

  /** Charge les dossiers depuis le backend — appeler après activation du vault. */
  async loadFolders(): Promise<void> {
    try {
      const paths = await this.storage.listFolders(this.vaultId, this.token)
      for (const p of paths) this._explicitFolders.add(p.endsWith('/') ? p : p + '/')
      this._notifyChange()
    } catch {
      // Folder list failure is non-fatal: folders with documents remain visible via their documents.
    }
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

    const pending = this._pendingFileCreates.get(normalizedPath)
    if (pending) return pending

    const request = (async () => {
      try {
        const doc = await this.storage.createDocument(this.vaultId, path, this.token)
        // Optimistic cache update — VaultHub event from other clients handled separately
        this.addDocument(doc)
      } catch (err) {
        // Idempotent create: "already exists" is not a hard failure.
        if (this._isConflictError(err)) {
          const existing = this.resolveDoc(path) ?? this.resolveDoc(normalizedPath)
          if (existing) this.addDocument(existing)
          return
        }
        throw err
      } finally {
        this._pendingFileCreates.delete(normalizedPath)
      }
    })()

    this._pendingFileCreates.set(normalizedPath, request)
    return request
  }

  async createFolder(path: string): Promise<void> {
    await this.storage.createFolder(this.vaultId, path, this.token)
    const normalized = path.endsWith('/') ? path : path + '/'
    this._explicitFolders.add(normalized)
    this._notifyChange()
  }

  async renameFile(documentId: string, newPath: string): Promise<void> {
    await this.renameDocument(documentId, newPath)
  }

  async deleteFile(documentId: string): Promise<void> {
    await this.deleteDocument(documentId)
  }

  async deleteFolder(path: string): Promise<void> {
    await this.storage.deleteFolder(this.vaultId, path, this.token)
    const prefix = path.endsWith('/') ? path : path + '/'
    for (const f of this._explicitFolders) {
      if (f === prefix || f.startsWith(prefix)) this._explicitFolders.delete(f)
    }
    this._notifyChange()
  }

  async uploadAttachment(file: File): Promise<string> {
    const { storagePath } = await this.storage.uploadAttachment(this.vaultId, file, this.token)
    const docPath = `attachments/${storagePath}`
    // Create a real document entry in the backend so the attachment persists across page refreshes.
    const doc = await this.storage.createDocument(this.vaultId, docPath, this.token)
    this.addDocument(doc)
    return docPath
  }

  resolveAttachmentUrl(path: string): string {
    const storagePath = path.startsWith('attachments/') ? path.slice('attachments/'.length) : path
    return this.storage.resolveFileUrl(this.vaultId, storagePath)
  }

  async renameDocument(documentId: string, newPath: string): Promise<void> {
    const normalizedNewPath = newPath.includes('.') ? newPath : `${newPath}.md`
    await this.storage.renameDocument(this.vaultId, documentId, normalizedNewPath, this.token)
    // Optimistic cache update
    this.renameDocumentInCache(documentId, normalizedNewPath)
  }

  async deleteDocument(documentId: string): Promise<void> {
    await this.storage.deleteDocument(this.vaultId, documentId, this.token)
    // Optimistic cache update
    this.removeDocument(documentId)
  }

  private _isConflictError(err: unknown): boolean {
    return err instanceof Error
      && (err.message.startsWith('409') || /conflict/i.test(err.message))
  }

  private _resolveDocumentByPath(path: string): IDocumentMeta | undefined {
    const normalizedPath = path.includes('.') ? path : `${path}.md`
    const doc = this.resolveDoc(path) ?? this.resolveDoc(normalizedPath)
    if (doc) this._documentsById.set(doc.id, doc)
    return doc
  }

  private _findDocumentByPath(path: string): IDocumentMeta | undefined {
    for (const doc of this._documentsById.values()) {
      if (doc.path === path) return doc
    }
    return undefined
  }
}
