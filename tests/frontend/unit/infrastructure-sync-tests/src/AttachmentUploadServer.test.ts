// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pieces jointes du profil serveur : progression reelle de l'envoi (XHR),
// rangement annonce au serveur, et images d'une note ouverte par un lien.
import { describe, it, expect, vi } from 'vitest'
import { RestVaultStorage, ServerVaultFiles, SharedNoteAttachments } from '@savoire/infrastructure-sync'

/** Faux XMLHttpRequest : on pilote la progression et la reponse a la main. */
class FakeXhr {
  method = ''
  url = ''
  headers: Record<string, string> = {}
  status = 0
  body: unknown
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(k: string, v: string) { this.headers[k] = v }
  send(body: unknown) { this.body = body }
  progress(loaded: number, total: number) { this.upload.onprogress?.({ lengthComputable: true, loaded, total }) }
  respond(status: number) { this.status = status; this.onload?.() }
}

function withXhr() {
  const xhr = new FakeXhr()
  const fetchFn = vi.fn(async () => ({ ok: true, status: 200 }))
  const storage = new RestVaultStorage({ fetchFn: fetchFn as never, xhrFactory: () => xhr as unknown as XMLHttpRequest })
  return { xhr, fetchFn, storage }
}

describe('envoi avec progression (mode serveur)', () => {
  it('suit les octets envoyes, avec le jeton, puis finit a 100 %', async () => {
    const { xhr, fetchFn, storage } = withXhr()
    const files = new ServerVaultFiles(storage, 'v1', () => 'tok')
    const seen: number[] = []
    const done = files.upload('doc-1', new File(['png'], 'a.png', { type: 'image/png' }), { onProgress: f => seen.push(f) })
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/v1/vaults/v1/attachments/doc-1')
    expect(xhr.headers.Authorization).toBe('Bearer tok')
    xhr.progress(25, 100)
    xhr.progress(80, 100)
    xhr.respond(200)
    await done
    expect(seen).toEqual([0.25, 0.8, 1])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('un refus du serveur rejette avec son code', async () => {
    const { xhr, storage } = withXhr()
    const done = storage.putAttachment('v1', 'doc-1', new Blob(['x']), 'tok', () => {})
    xhr.respond(400)
    await expect(done).rejects.toThrow('400')
  })

  it('une coupure reseau rejette', async () => {
    const { xhr, storage } = withXhr()
    const done = storage.putAttachment('v1', 'doc-1', new Blob(['x']), 'tok', () => {})
    xhr.onerror?.()
    await expect(done).rejects.toThrow('network')
  })

  it('sans suivi demande, fetch reste le chemin', async () => {
    const { xhr, fetchFn, storage } = withXhr()
    await storage.putAttachment('v1', 'doc-1', new Blob(['x']), 'tok')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(xhr.method).toBe('')
  })
})

describe('rangement annonce au serveur', () => {
  it('PUT .../placement avec la note et le nom', async () => {
    const fetchFn = vi.fn(async () => ({ ok: true, status: 204 }))
    const files = new ServerVaultFiles(new RestVaultStorage({ fetchFn: fetchFn as never }), 'v1', () => 'tok')
    await files.place('img-1', { noteId: 'note-1', name: 'Photo.png' })
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/vaults/v1/attachments/img-1/placement', expect.objectContaining({
      method: 'PUT',
      body: JSON.stringify({ noteId: 'note-1', name: 'Photo.png' }),
    }))
  })
})

describe('SharedNoteAttachments (page de partage)', () => {
  function setup(list: Array<{ id: string; name: string | null }>) {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/documents/note-1/attachments')) return { ok: true, status: 200, json: async () => list }
      if (url.endsWith('/attachments/img-1')) return { ok: true, status: 200, blob: async () => new Blob(['img']) }
      return { ok: false, status: 403 }
    })
    const shared = new SharedNoteAttachments(new RestVaultStorage({ fetchFn: fetchFn as never }), 'v1', 'note-1', () => 'share-tok')
    return { fetchFn, shared }
  }

  it('resout une image du dossier de la note par son nom ou son chemin, avec le jeton du lien', async () => {
    const { fetchFn, shared } = setup([{ id: 'img-1', name: 'Photo.png' }])
    const url = await shared.url('Photo.png')
    expect(url).toMatch(/^blob:/)
    expect(await shared.url('Ma note/Photo.png')).toBe(url)
    expect(fetchFn).toHaveBeenCalledWith('/api/v1/vaults/v1/documents/note-1/attachments',
      expect.objectContaining({ headers: { Authorization: 'Bearer share-tok' } }))
    // La liste et l'image ne sont lues qu'une fois.
    expect(fetchFn).toHaveBeenCalledTimes(2)
    shared.dispose()
  })

  it('une image hors du dossier de la note est introuvable', async () => {
    const { shared } = setup([{ id: 'img-1', name: 'Photo.png' }])
    await expect(shared.url('attachments/Ailleurs.png')).rejects.toThrow('hors du dossier')
  })
})
