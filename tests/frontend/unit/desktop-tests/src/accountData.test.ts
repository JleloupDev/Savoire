// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Parametres → Compte : l'export des donnees (vaults du serveur ET vaults du
// poste, lus sur le disque en version bureau) et la suppression du compte.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readZip } from '@savoire/application'
import { InMemoryVaultFileSystem } from '@savoire/platform'
import { TauriVaultFileSystem } from '@savoire/desktop'
import { FakeBridge } from './fakeBridge'
import { zipEntriesOf } from '../../../../../apps/web/src/vaultTransfer'
import { apiCaller, buildAccountExport, deleteAccount, ownedVaults, type ExportableVault } from '../../../../../apps/web/src/accountData'

const text = (b: Uint8Array) => new TextDecoder().decode(b)
const mem = (name: string) => new InMemoryVaultFileSystem({ rootLabel: name, watch: false })

async function folder(name: string, files: Record<string, string>) {
  const fs = mem(name)
  for (const [p, c] of Object.entries(files)) await fs.writeBytes(p, new TextEncoder().encode(c))
  return fs
}

const owner = (id: string, name: string): ExportableVault => ({ id, name, role: 'owner', source: 'server' })
const guest = (id: string, name: string): ExportableVault => ({ id, name, role: 'viewer', source: 'server' })
const local = (id: string, name: string): ExportableVault => ({ id, name, role: 'local', source: 'local' })

describe('export des donnees du compte', () => {
  it('garde les vaults possedes et ceux du poste, pas ceux des autres', () => {
    expect(ownedVaults([owner('1', 'A'), guest('2', 'B'), local('l', 'C')]).map(v => v.id)).toEqual(['1', 'l'])
  })

  it('archive : compte.json, un dossier par vault du serveur et du disque', async () => {
    const out = await buildAccountExport({
      profile: { id: 'u1', displayName: 'Ana', email: 'ana@test.fr' },
      vaults: [owner('s1', 'Notes'), guest('s2', 'De Bob'), local('l1', 'Notes')],
      memoryFolder: mem,
      copyServerVault: async (_v, fs) => { await fs.writeBytes('a.md', new TextEncoder().encode('# serveur')); return [] },
      localFolder: async () => folder('Disque', { 'dossier/b.md': '# disque', 'img.png': 'png' }),
      now: () => new Date(Date.UTC(2026, 10, 20)),
    })
    expect(out.vaults).toBe(2)
    expect(out.errors).toEqual([])
    const files = await readZip(new Uint8Array(await out.blob.arrayBuffer()))
    const byPath = new Map(files.map(f => [f.path, text(f.bytes)]))
    // Deux vaults nommes « Notes » : le second prend un numero.
    expect(byPath.get('Notes/a.md')).toBe('# serveur')
    expect(byPath.get('Notes (2)/dossier/b.md')).toBe('# disque')
    expect(byPath.has('Notes (2)/img.png')).toBe(true)
    expect([...byPath.keys()].some(p => p.startsWith('De Bob'))).toBe(false)
    const info = JSON.parse(byPath.get('compte.json')!)
    expect(info.account).toEqual({ id: 'u1', displayName: 'Ana', email: 'ana@test.fr' })
    expect(info.exportedAt).toBe('2026-11-20T00:00:00.000Z')
    expect(info.vaults.map((v: { folder: string }) => v.folder)).toEqual(['Notes', 'Notes (2)'])
  })

  it('un vault en erreur ne bloque pas les autres et est signale', async () => {
    const out = await buildAccountExport({
      profile: { id: 'u1', displayName: 'Ana', email: '' },
      vaults: [owner('s1', 'Casse'), owner('s2', 'Bon')],
      memoryFolder: mem,
      copyServerVault: async (v, fs) => {
        if (v.id === 's1') throw new Error('serveur injoignable')
        await fs.writeBytes('ok.md', new TextEncoder().encode('ok'))
        return ['1 document illisible']
      },
    })
    expect(out.vaults).toBe(1)
    expect(out.errors).toEqual(['Casse : serveur injoignable', 'Bon : 1 document illisible'])
    const files = await readZip(new Uint8Array(await out.blob.arrayBuffer()))
    expect(files.map(f => f.path)).toContain('Bon/ok.md')
  })

  it('sans dossier du poste (navigateur), les vaults locaux sont ignores', async () => {
    const out = await buildAccountExport({ profile: { id: 'u', displayName: 'U', email: '' }, vaults: [local('l', 'Local')], memoryFolder: mem, copyServerVault: async () => [] })
    expect(out.vaults).toBe(0)
  })
})

describe('export d\'un vault local sur disque (bureau)', () => {
  it('lit le dossier par les commandes Tauri : notes, sous-dossiers, dossier vide, .savoire', async () => {
    const disk: Record<string, string> = { 'a.md': '# a', 'Projet/b.md': '# b', '.savoire/vault.json': '{}' }
    const bridge = new FakeBridge()
      .on('vault_list', () => [
        { path: '.savoire', kind: 'directory' }, { path: '.savoire/vault.json', kind: 'file', mtimeMs: 1_700_000_000_000 },
        { path: 'Projet', kind: 'directory' }, { path: 'Projet/b.md', kind: 'file' },
        { path: 'Vide', kind: 'directory' }, { path: 'a.md', kind: 'file' },
      ])
      .on('vault_read_bytes', (args) => new TextEncoder().encode(disk[(args as { path: string }).path]))
    const fs = new TauriVaultFileSystem(bridge, '/home/moi/Notes')
    const out = await buildAccountExport({
      profile: { id: 'u', displayName: 'U', email: '' },
      vaults: [local('/home/moi/Notes', 'Notes')],
      memoryFolder: mem,
      copyServerVault: async () => { throw new Error('pas de serveur') },
      localFolder: async () => fs,
    })
    expect(out.errors).toEqual([])
    const files = await readZip(new Uint8Array(await out.blob.arrayBuffer()))
    const byPath = new Map(files.map(f => [f.path, text(f.bytes)]))
    expect(byPath.get('Notes/a.md')).toBe('# a')
    expect(byPath.get('Notes/Projet/b.md')).toBe('# b')
    expect(byPath.get('Notes/.savoire/vault.json')).toBe('{}')
    // Le dossier vide garde son entree dans l'archive (readZip ne rend que les fichiers).
    const paths = (await zipEntriesOf(fs, 'Notes/')).map(e => e.path)
    expect(paths).toContain('Notes/Vide/')
    expect(paths).not.toContain('Notes/Projet/')
  })
})

describe('suppression du compte', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('envoie la confirmation attendue par le serveur', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    await deleteAccount(apiCaller(() => 'jwt', p => `http://s${p}`))
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/api/v1/auth/me')
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(String(init.body))).toEqual({ confirm: 'SUPPRIMER' })
  })

  it('un refus du serveur remonte son message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ detail: 'Le fournisseur refuse.' }), { status: 502 })))
    await expect(deleteAccount(apiCaller(() => 'jwt', p => `http://s${p}`))).rejects.toThrow('Le fournisseur refuse.')
  })
})
