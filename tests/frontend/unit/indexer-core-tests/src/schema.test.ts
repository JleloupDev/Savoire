// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Schema versionne : base neuve, reouverture, version de pouvoir changee,
// pouvoir ajoute ou retire, noyau d'une autre version. L'index est derive :
// pas de migration en place, une reconstruction demandee.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VaultIndex, defaultPowers, method, tagsPower } from '@savoire/indexer-core'
import type { IndexPower, SqlDriver } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'

const tables = async (driver: SqlDriver) =>
  (await driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_fts_%' ORDER BY name"))
    .map(r => r.name)

const tagCount = async (index: VaultIndex) => ((await index.call('tags', 'list', {})) as { items: unknown[] }).items.length

describe('schema', () => {
  it('base neuve : tables du noyau et des pouvoirs, reconstruction demandee jusqu a markBuilt', async () => {
    const driver = NodeSqliteDriver.open(':memory:')
    const index = await VaultIndex.open(driver)
    expect(await tables(driver)).toEqual(['aliases', 'docs', 'links', 'meta', 'props', 'search_fts', 'search_text', 'tags'])
    expect(index.rebuildRequired).toBe(true)
    expect(await index.seq()).toBe(0)
    await index.applyDoc({ id: 'a', path: 'A.md', content: '#tag' }, { seq: 12 })
    await index.markBuilt()
    expect(index.rebuildRequired).toBe(false)

    const again = await VaultIndex.open(driver)
    expect(again.rebuildRequired).toBe(false)
    expect(await again.seq()).toBe(12)
    expect(await tagCount(again)).toBe(1)
  })

  it('version d un pouvoir changee : ses tables sont videes, le reste garde, reconstruction demandee', async () => {
    const driver = NodeSqliteDriver.open(':memory:')
    const index = await VaultIndex.open(driver)
    await index.applyDoc({ id: 'a', path: 'A.md', content: '---\nx: 1\n---\n#tag' }, { seq: 5 })
    await index.markBuilt()

    const powers = defaultPowers().map(p => (p.name === 'tags' ? { ...tagsPower, version: tagsPower.version + 1 } : p))
    const upgraded = await VaultIndex.open(driver, { powers })
    expect(upgraded.rebuildRequired).toBe(true)
    expect(await upgraded.seq()).toBe(0)
    expect(await tagCount(upgraded)).toBe(0)
    expect((await upgraded.queryEngine().query({ from: { notes: true }, where: { field: { prop: 'x' }, op: 'eq', value: 1 } })).total).toBe(1)
    // Reconstruction : la note est reecrite, tout revient.
    await upgraded.applyDoc({ id: 'a', path: 'A.md', content: '---\nx: 1\n---\n#tag' })
    expect(await tagCount(upgraded)).toBe(1)
  })

  it('pouvoir ajoute puis retire : ses tables naissent puis partent', async () => {
    const extra: IndexPower = {
      name: 'compte',
      version: 1,
      tables: ['compte_mots'],
      schema: ['CREATE TABLE IF NOT EXISTS compte_mots (doc INTEGER PRIMARY KEY, n INTEGER NOT NULL)'],
      methods: { total: method({ parse: () => ({}), run: async () => 0 }) },
    }
    const driver = NodeSqliteDriver.open(':memory:')
    await (await VaultIndex.open(driver)).markBuilt()
    const withExtra = await VaultIndex.open(driver, { powers: [...defaultPowers(), extra] })
    expect(withExtra.rebuildRequired).toBe(true)
    expect(await tables(driver)).toContain('compte_mots')
    await withExtra.markBuilt()
    const without = await VaultIndex.open(driver)
    expect(without.rebuildRequired).toBe(false)
    expect(await tables(driver)).not.toContain('compte_mots')
  })

  it('noyau d une autre version : tout est vide et reconstruit', async () => {
    const driver = NodeSqliteDriver.open(':memory:')
    const index = await VaultIndex.open(driver)
    await index.applyDoc({ id: 'a', path: 'A.md', content: 'texte' })
    await index.markBuilt()
    await driver.batch([{ sql: "UPDATE meta SET value = '0' WHERE key = 'core'" }])
    const reopened = await VaultIndex.open(driver)
    expect(reopened.rebuildRequired).toBe(true)
    expect((await reopened.queryEngine().query({ from: { notes: true } })).total).toBe(0)
    expect((await reopened.searchEngine().search({ text: 'texte' })).total).toBe(0)
  })

  it('fichier sur disque : mode WAL, reouverture par un autre processus de la meme facon', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'savoire-index-'))
    try {
      const file = join(dir, 'vault.sqlite')
      const driver = NodeSqliteDriver.open(file)
      expect(await driver.all('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }])
      const index = await VaultIndex.open(driver)
      await index.applyDoc({ id: 'a', path: 'A.md', content: 'persistant' }, { seq: 3 })
      await index.close()
      const reopened = await VaultIndex.open(NodeSqliteDriver.open(file))
      expect(await reopened.seq()).toBe(3)
      expect((await reopened.searchEngine().search({ text: 'persistant' })).total).toBe(1)
      await reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
