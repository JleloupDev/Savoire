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
import type { IDocumentMeta, IVaultDirectory, IVaultStorage } from './ports'
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

  /** Get current document list. */
  get documents(): readonly IDocumentMeta[] {
    return this.directory.getAll()
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
    const meta = this.directory.getById(documentId)
    if (!meta) throw new Error(`Document not found: ${documentId}`)
    await this.documentStore.writeContent(this.vaultId, documentId, content, this.token)
  }

  // see ADR-010
  async list(dir?: string): Promise<string[]> {
    const prefix = !dir ? '' : dir.endsWith('/') ? dir : dir + '/'
    const result = new Set<string>()
    for (const doc of this.directory.getAll()) {
      if (!doc.path.startsWith(prefix)) continue
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
    const id = crypto.randomUUID()
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

  async deleteFile(documentId: string): Promise<void> {
    await this.deleteDocument(documentId)
  }

  async deleteFolder(path: string): Promise<void> {
    // Remove the folder and any sub-folders from the CRDT directory.
    const prefix = path.endsWith('/') ? path : path + '/'
    for (const f of this.directory.getFolders()) {
      if (f === prefix || f.startsWith(prefix)) this.directory.removeFolder(f)
    }
  }

  async uploadAttachment(file: File): Promise<string> {
    const { storagePath } = await this.storage.uploadAttachment(this.vaultId, file, this.token)
    const docPath = `attachments/${storagePath}`
    // Register the attachment as a CRDT directory entry (emits a local vault op).
    this.addDocument({ id: crypto.randomUUID(), path: docPath })
    return docPath
  }

  resolveAttachmentUrl(path: string): string {
    const storagePath = path.startsWith('attachments/') ? path.slice('attachments/'.length) : path
    return this.storage.resolveFileUrl(this.vaultId, storagePath)
  }

  async renameDocument(documentId: string, newPath: string): Promise<void> {
    const normalizedNewPath = newPath.includes('.') ? newPath : `${newPath}.md`
    this.renameDocumentInCache(documentId, normalizedNewPath)
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
