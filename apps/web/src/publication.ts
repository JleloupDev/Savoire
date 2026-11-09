// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Publier une note sur le web (en direct, comme Notion). L'application rend
// la note en HTML et l'envoie au serveur, qui la sert sous /p/<nom>.
//
// En direct : une note publiee est renvoyee apres chaque modification
// stabilisee (regroupee), par l'application de qui l'edite.
import { serverUrl } from '@savoire/infrastructure-sync'
import { renderNoteForWeb, type NoteRenderOptions } from '@savoire/editor-core'

export interface PublicationInfo {
  slug: string
  path: string
  indexable: boolean
  createdAt: string
  updatedAt: string
}

export interface PublicationDeps {
  token(): string
  vaultId(): string | undefined
  /** Le texte courant d'une note. */
  read(docId: string): Promise<string>
  /** Rendu des blocs des plugins (callouts, bases, diagrammes...). */
  renderOptions(): Omit<NoteRenderOptions, 'title'>
  canWrite(): boolean
}

/** Delai de regroupement des modifications avant de republier (ms). */
const REPUBLISH_MS = 4000

export class PublicationService {
  /** Etat connu par note : null = pas publiee. */
  private readonly known = new Map<string, PublicationInfo | null>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private deps: PublicationDeps | null = null) {}

  /** L'application branche ses acces (jeton, vault, lecture, rendu). */
  configure(deps: PublicationDeps): void {
    this.deps = deps
  }

  private get d(): PublicationDeps {
    if (!this.deps) throw new Error('Publication indisponible.')
    return this.deps
  }

  publicUrl(info: PublicationInfo): string {
    return new URL(serverUrl(info.path), window.location.href).toString()
  }

  async status(docId: string): Promise<PublicationInfo | null> {
    const res = await this.call('GET', docId)
    const info = res.status === 204 ? null : await res.json() as PublicationInfo
    this.known.set(docId, info)
    return info
  }

  /** Publie (ou met a jour) la page de la note. */
  async publish(docId: string, path: string, indexable: boolean): Promise<PublicationInfo> {
    const title = (path.split('/').pop() ?? path).replace(/\.md$/i, '')
    const text = await this.d.read(docId)
    // La note commence deja par un titre : pas de second titre au-dessus.
    const startsWithHeading = /^\s*(?:---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n\s*)?#\s+\S/.test(text)
    const { html, description } = await renderNoteForWeb(text, { ...this.d.renderOptions(), title: startsWithHeading ? '' : title })
    const res = await this.call('PUT', docId, { title, description, html, indexable })
    const info = await res.json() as PublicationInfo
    this.known.set(docId, info)
    return info
  }

  async unpublish(docId: string): Promise<void> {
    await this.call('DELETE', docId)
    this.known.set(docId, null)
  }

  /** Une note a change : si elle est publiee, sa page suit (regroupe). */
  noteChanged(docId: string, path: string): void {
    if (!this.deps?.canWrite() || !path.toLowerCase().endsWith('.md')) return
    const cached = this.known.get(docId)
    if (cached === null) return
    const prev = this.timers.get(docId)
    if (prev) clearTimeout(prev)
    this.timers.set(docId, setTimeout(() => {
      this.timers.delete(docId)
      void (async () => {
        const info = cached ?? await this.status(docId)
        if (info) await this.publish(docId, path, info.indexable)
      })().catch(err => console.warn('[publication] mise a jour impossible', err))
    }, REPUBLISH_MS))
  }

  /** Changement de vault : on oublie tout. */
  reset(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.known.clear()
  }

  private async call(method: 'GET' | 'PUT' | 'DELETE', docId: string, body?: unknown): Promise<Response> {
    const vaultId = this.d.vaultId()
    if (!vaultId) throw new Error('Aucun vault ouvert.')
    const res = await fetch(serverUrl(`/api/v1/vaults/${encodeURIComponent(vaultId)}/documents/${encodeURIComponent(docId)}/publication`), {
      method,
      headers: { authorization: `Bearer ${this.d.token()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(res.status === 403 ? 'Vous n’avez pas le droit de publier cette note.' : `Publication impossible (${res.status}). ${detail.slice(0, 160)}`)
    }
    return res
  }
}

/** Le service de l'application (un vault ouvert a la fois). */
export const publications = new PublicationService()
