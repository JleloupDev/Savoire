// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ce que l'hote (pair indexeur) lit de l'index sans l'ouvrir : inspect()
// avant open() pour reconstruire a cote, chemins de quelques notes, valeurs
// propres a l'hote.
import { describe, it, expect } from 'vitest'
import { VaultIndex, defaultPowers, tagsPower } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'

describe('VaultIndex.inspect', () => {
  it('base vide : rien n existe, reconstruction a faire, rien n est ecrit', async () => {
    const driver = NodeSqliteDriver.open(':memory:')
    const info = await VaultIndex.inspect(driver)
    expect(info).toMatchObject({ exists: false, rebuildRequired: true, coreChanged: true, built: false, seq: 0, intact: [] })
    expect(await driver.all("SELECT name FROM sqlite_master")).toEqual([])
  })

  it('base construite : rien a refaire, sequence et valeurs de l hote lues', async () => {
    const driver = NodeSqliteDriver.open(':memory:')
    const index = await VaultIndex.open(driver)
    await index.applyDoc({ id: 'a', path: 'A.md', content: '#x' }, { seq: 7 })
    await index.setHostMeta({ epoch: 'e1' })
    await index.markBuilt()
    const info = await VaultIndex.inspect(driver)
    expect(info).toMatchObject({ exists: true, rebuildRequired: false, coreChanged: false, built: true, seq: 7, changed: [], host: { epoch: 'e1' } })
    expect(info.intact).toEqual(defaultPowers().map(p => p.name))
  })

  it('pouvoir d une autre version : il est seul a changer, la base n est pas touchee', async () => {
    const driver = NodeSqliteDriver.open(':memory:')
    const index = await VaultIndex.open(driver)
    await index.applyDoc({ id: 'a', path: 'A.md', content: '#x' })
    await index.markBuilt()
    const powers = defaultPowers().map(p => (p.name === 'tags' ? { ...tagsPower, version: tagsPower.version + 1 } : p))
    const info = await VaultIndex.inspect(driver, { powers })
    expect(info.rebuildRequired).toBe(true)
    expect(info.coreChanged).toBe(false)
    expect(info.changed).toEqual(['tags'])
    expect(info.intact).not.toContain('tags')
    // L'ancienne version repond encore avec les pouvoirs intacts.
    const old = await VaultIndex.open(driver, { powers: powers.filter(p => info.intact.includes(p.name)) })
    expect(old.rebuildRequired).toBe(false)
    expect((await old.call('index', 'status', {}) as { docs: number }).docs).toBe(1)
  })
})

describe('chemins et valeurs de l hote', () => {
  it('paths(ids) : seulement les notes demandees et indexees', async () => {
    const index = await VaultIndex.open(NodeSqliteDriver.open(':memory:'))
    await index.applyDocs([
      { id: 'a', path: 'A.md', content: '' },
      { id: 'b', path: 'Dossier/B.md', content: '' },
      { id: 'c', path: 'C.md', content: '' },
    ])
    expect([...await index.paths(['b', 'z', 'b'])]).toEqual([['b', 'Dossier/B.md']])
    expect((await index.paths()).size).toBe(3)
  })

  it('setHostMeta / hostMeta : prefixees, sans toucher aux cles du noyau', async () => {
    const driver = NodeSqliteDriver.open(':memory:')
    const index = await VaultIndex.open(driver)
    await index.setHostMeta({ epoch: 'abc', seq: 'pas la sequence' })
    expect(await index.hostMeta()).toEqual({ epoch: 'abc', seq: 'pas la sequence' })
    expect(await index.seq()).toBe(0)
  })
})
