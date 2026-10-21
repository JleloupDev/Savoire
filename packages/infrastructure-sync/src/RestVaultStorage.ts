// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { serverUrl } from './serverAddress'
import { fetchWithRenewal, renewRejectedToken } from './http'
import type { IDocumentMeta, IVaultStorage } from '@savoire/platform'

export interface RestVaultStorageOptions {
  baseUrl?: string
  fetchFn?: typeof fetch
  /**
   * Fabrique de XMLHttpRequest, pour suivre la progression d'un envoi. Par
   * defaut celle du navigateur, sauf si `fetchFn` est fourni (tests) ; null
   * pour s'en passer.
   */
  xhrFactory?: (() => XMLHttpRequest) | null
}

/** Envoi d'un formulaire avec suivi des octets envoyes. Rejette avec le code HTTP, comme fetch. */
function sendWithProgress(xhr: XMLHttpRequest, url: string, token: string, body: FormData, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    xhr.open('POST', url)
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.upload.onprogress = e => { if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve() }
      else reject(new Error(`${xhr.status}`))
    }
    xhr.onerror = () => reject(new Error('network error'))
    xhr.onabort = () => reject(new Error('envoi annule'))
    xhr.send(body)
  })
}

export class RestVaultStorage implements IVaultStorage {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly xhrFactory: (() => XMLHttpRequest) | null

  constructor(options: RestVaultStorageOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    // Un 401 renouvelle le jeton et rejoue la requete une fois (voir http.ts).
    const raw = options.fetchFn ?? globalThis.fetch.bind(globalThis)
    this.fetchFn = ((input: string, init?: RequestInit) => fetchWithRenewal(raw, input, init)) as typeof fetch
    const browserXhr = typeof XMLHttpRequest !== 'undefined' && !options.fetchFn ? () => new XMLHttpRequest() : null
    this.xhrFactory = options.xhrFactory === undefined ? browserXhr : options.xhrFactory
  }

  async readFile(vaultId: string, path: string, token: string): Promise<string> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(path)}`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    return res.text()
  }

  async writeFile(vaultId: string, path: string, content: string, token: string): Promise<void> {
    const blob = new Blob([content], { type: 'text/markdown' })
    const file = new File([blob], path.split('/').at(-1) ?? 'file.md', { type: 'text/markdown' })
    const form = new FormData()
    form.append('file', file)

    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments`),
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
    )
    if (!res.ok) throw new Error(`${res.status}`)
  }

  resolveFileUrl(vaultId: string, path: string): string {
    return this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(path)}`)
  }

  async listDocuments(vaultId: string, token: string): Promise<IDocumentMeta[]> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<IDocumentMeta[]>
  }

  // These three are always overridden by DocumentsService.activateVault (VaultHub delegate).
  // The REST endpoints they used to call no longer exist.
  createDocument(): Promise<IDocumentMeta> {
    throw new Error('createDocument must go through VaultHub — use DocumentsService.activateVault')
  }

  renameDocument(): Promise<void> {
    throw new Error('renameDocument must go through VaultHub — use DocumentsService.activateVault')
  }

  deleteDocument(): Promise<void> {
    throw new Error('deleteDocument must go through VaultHub — use DocumentsService.activateVault')
  }

  async uploadAttachment(vaultId: string, file: File, token: string): Promise<{ fileName: string; storagePath: string }> {
    const form = new FormData()
    form.append('file', file)
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments`),
      { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    const dto = await res.json() as { fileName: string; path: string }
    return { fileName: dto.fileName, storagePath: dto.path }
  }

  /**
   * Range un fichier sous l'id de son document (POST .../attachments/{fileId}).
   * Avec `onProgress`, l'envoi passe par XMLHttpRequest, seul a mesurer les
   * octets envoyes ; fetch reste le chemin sans suivi (et celui des tests).
   */
  async putAttachment(vaultId: string, fileId: string, file: Blob, token: string, onProgress?: (fraction: number) => void): Promise<void> {
    const form = new FormData()
    // Le serveur controle l'extension : le nom d'origine la porte.
    form.append('file', file, file instanceof File ? file.name : fileId)
    const url = this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(fileId)}`)
    if (onProgress && this.xhrFactory) {
      try {
        await sendWithProgress(this.xhrFactory(), url, token, form, onProgress)
      } catch (err) {
        // Jeton refuse : un seul nouvel envoi, avec le jeton renouvele.
        const next = err instanceof Error && err.message === '401' ? await renewRejectedToken(token) : null
        if (!next) throw err
        await sendWithProgress(this.xhrFactory(), url, next, form, onProgress)
      }
      return
    }
    const res = await this.fetchFn(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    if (!res.ok) throw new Error(`${res.status}`)
  }

  /** Annonce le rangement d'une piece jointe (PUT .../attachments/{fileId}/placement). */
  async placeAttachment(vaultId: string, fileId: string, placement: { noteId: string | null; name: string }, token: string): Promise<void> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(fileId)}/placement`),
      {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(placement),
      },
    )
    if (!res.ok) throw new Error(`${res.status}`)
  }

  /** Pieces jointes rangees dans le dossier d'une note (page de partage). */
  async listNoteAttachments(vaultId: string, docId: string, token: string): Promise<{ id: string; name: string | null }[]> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/attachments`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    return res.json() as Promise<{ id: string; name: string | null }[]>
  }

  /** Lit une piece jointe en requete authentifiee (une <img> ne sait pas porter le jeton). */
  async fetchAttachment(vaultId: string, path: string, token: string): Promise<Blob> {
    const res = await this.fetchFn(
      this.resolve(`/api/v1/vaults/${encodeURIComponent(vaultId)}/attachments/${encodeURIComponent(path)}`),
      { method: 'GET', headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`${res.status}`)
    return res.blob()
  }

  private resolve(path: string): string {
    return serverUrl(path, this.baseUrl)
  }
}
