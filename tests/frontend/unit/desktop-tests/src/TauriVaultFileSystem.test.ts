// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { TauriVaultFileSystem, FS_CHANGE_EVENT } from '@savoire/desktop'
import { FakeBridge, flush } from './fakeBridge'

const ROOT = '/home/moi/Notes été'

describe('TauriVaultFileSystem', () => {
  it('passe la racine et le chemin relatif a chaque commande', async () => {
    const bridge = new FakeBridge()
      .on('vault_read_text', () => '# Note')
      .on('vault_list', () => [{ path: 'a.md', kind: 'file', size: 6 }])
      .on('vault_exists', () => true)
      .on('vault_stat', () => null)
    const fs = new TauriVaultFileSystem(bridge, ROOT)

    expect(await fs.readText('Projet/Note.md')).toBe('# Note')
    await fs.writeText('a.md', 'bonjour')
    expect(await fs.list('', { recursive: true })).toEqual([{ path: 'a.md', kind: 'file', size: 6 }])
    expect(await fs.exists('a.md')).toBe(true)
    expect(await fs.stat('x.md')).toBeNull()
    await fs.mkdir('Projet')
    await fs.rename('a.md', 'Projet/a.md')
    await fs.remove('Projet')

    expect(bridge.calls.map(c => [c.cmd, c.args])).toEqual([
      ['vault_read_text', { root: ROOT, path: 'Projet/Note.md' }],
      ['vault_write_text', { root: ROOT, path: 'a.md', content: 'bonjour' }],
      ['vault_list', { root: ROOT, dir: '', recursive: true }],
      ['vault_exists', { root: ROOT, path: 'a.md' }],
      ['vault_stat', { root: ROOT, path: 'x.md' }],
      ['vault_mkdir', { root: ROOT, path: 'Projet' }],
      ['vault_rename', { root: ROOT, from: 'a.md', to: 'Projet/a.md' }],
      ['vault_remove', { root: ROOT, path: 'Projet' }],
    ])
  })

  it('lit des octets bruts et les ecrit en corps binaire, en-tetes encodes', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const bridge = new FakeBridge().on('vault_read_bytes', () => bytes.buffer.slice(0))
    const fs = new TauriVaultFileSystem(bridge, ROOT)

    const read = await fs.readBytes('img/é.png')
    expect(read).toBeInstanceOf(Uint8Array)
    expect([...read]).toEqual([1, 2, 3])

    await fs.writeBytes('img/é.png', bytes)
    const call = bridge.calls[1]
    expect(call.cmd).toBe('vault_write_bytes')
    expect(call.args).toBe(bytes)
    expect(call.options?.headers).toEqual({
      'x-vault-root': encodeURIComponent(ROOT),
      'x-vault-path': encodeURIComponent('img/é.png'),
    })
    // Un en-tete HTTP ne porte que de l'ASCII.
    for (const v of Object.values(call.options?.headers ?? {})) expect(v).toMatch(/^[\x20-\x7e]*$/)
  })

  it('surveille le disque : ecoute avant de demander, ne garde que sa surveillance', async () => {
    const bridge = new FakeBridge().on('vault_watch', () => 7)
    const fs = new TauriVaultFileSystem(bridge, ROOT)
    const cb = vi.fn()

    const stop = fs.watch(cb)
    await flush()
    expect(bridge.commands()).toEqual(['vault_watch'])
    expect(bridge.listenerCount(FS_CHANGE_EVENT)).toBe(1)

    bridge.emit(FS_CHANGE_EVENT, { watchId: 7, changes: [{ path: 'a.md', kind: 'modified' }] })
    bridge.emit(FS_CHANGE_EVENT, { watchId: 8, changes: [{ path: 'b.md', kind: 'created' }] })
    bridge.emit(FS_CHANGE_EVENT, { watchId: 7, changes: [] })
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith([{ path: 'a.md', kind: 'modified' }])

    stop()
    expect(bridge.listenerCount(FS_CHANGE_EVENT)).toBe(0)
    expect(bridge.calls.at(-1)).toMatchObject({ cmd: 'vault_unwatch', args: { watchId: 7 } })
    bridge.emit(FS_CHANGE_EVENT, { watchId: 7, changes: [{ path: 'a.md', kind: 'modified' }] })
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('un arret avant la fin de l\'abonnement ne laisse rien derriere lui', async () => {
    const bridge = new FakeBridge().on('vault_watch', () => 3)
    const fs = new TauriVaultFileSystem(bridge, ROOT)
    const stop = fs.watch(() => {})
    stop()
    await flush()
    await flush()
    expect(bridge.listenerCount(FS_CHANGE_EVENT)).toBe(0)
    // Soit la surveillance n'a jamais ete demandee, soit elle a ete rendue.
    const cmds = bridge.commands()
    if (cmds.includes('vault_watch')) expect(cmds).toContain('vault_unwatch')
  })
})
