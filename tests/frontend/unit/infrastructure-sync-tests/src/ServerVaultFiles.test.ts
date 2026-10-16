// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Pieces jointes du profil serveur : toujours avec le jeton, et affichees par
// une URL blob: (une <img> ne sait pas porter le jeton).
import { describe, it, expect, vi } from 'vitest'
import { RestVaultStorage, ServerVaultFiles } from '@savoire/infrastructure-sync'

function setup(responses: Array<{ ok: boolean; status: number; blob?: Blob }>) {
  const fetchFn = vi.fn(async () => {
    const r = responses.shift() ?? { ok: true, status: 200 }
    return { ok: r.ok, status: r.status, blob: async () => r.blob ?? new Blob(['x']) }
  })
  const files = new ServerVaultFiles(new RestVaultStorage({ fetchFn: fetchFn as never }), 'v1', () => 'tok')
  return { fetchFn, files }
}

describe('ServerVaultFiles', () => {
  it('range le fichier sous l\'id du document, avec le jeton', async () => {
    const { fetchFn, files } = setup([{ ok: true, status: 200 }])
    await files.upload('doc-1', new File(['png'], 'Mon image.png', { type: 'image/png' }))
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/vaults/v1/attachments/doc-1',
      expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer tok' } }),
    )
  })

  it('lit l\'image en requete authentifiee et rend une URL blob:, gardee en cache', async () => {
    const { fetchFn, files } = setup([{ ok: true, status: 200, blob: new Blob(['img'], { type: 'image/png' }) }])
    const url = await files.url('doc-1')
    expect(url).toMatch(/^blob:/)
    expect(await files.url('doc-1')).toBe(url)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith(
      '/api/v1/vaults/v1/attachments/doc-1',
      expect.objectContaining({ method: 'GET', headers: { Authorization: 'Bearer tok' } }),
    )
    files.dispose()
  })

  it('un refus rejette et n\'est pas garde en cache', async () => {
    const { fetchFn, files } = setup([{ ok: false, status: 404 }, { ok: true, status: 200 }])
    await expect(files.url('doc-2')).rejects.toThrow('404')
    expect(await files.url('doc-2')).toMatch(/^blob:/)
    expect(fetchFn).toHaveBeenCalledTimes(2)
    files.dispose()
  })
})
