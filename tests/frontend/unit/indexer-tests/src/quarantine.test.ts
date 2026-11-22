// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un fichier qui fait tomber le fil d'indexation (extracteur : OCR, PDF...)
// est mis de cote apres quelques chutes de suite, avec un rapport d'erreur,
// au lieu de faire tomber le fil sans fin.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXTRACTOR as CSV } from '../../../../../packages/plugins/plugin-csv/src/index'
import { createLogger } from '../../../../../apps/indexer/src/log'
import { FileQuarantine } from '../../../../../apps/indexer/src/quarantine'
import { FakeBackend } from './fakeBackend'
import { Peer, TOKEN, startPeer, tempDir, until } from './harness'

let tmp: { dir: string; cleanup: () => void }
let lines: string[]

const bytes = (s: string) => new TextEncoder().encode(s)
const all = () => true

function quarantine(after = 3, version = 'test'): FileQuarantine {
  return new FileQuarantine({ dataDir: tmp.dir, shard: 0, version, after, log: createLogger('debug', {}, l => lines.push(l)) })
}

/** Une incarnation du fil : demarre (lit le journal laisse), puis tombe pendant la lecture de `doc`. */
function crashWhileReading(doc: string, content: Uint8Array, opts: { after?: number; version?: string; error?: Error } = {}): FileQuarantine {
  const q = quarantine(opts.after, opts.version)
  q.start(all)
  q.begin('v1', doc, `Dossier/${doc}.png`, content, 'images@2')
  if (opts.error) q.crashed(opts.error)
  return q
}

const logged = (level: string) => lines.map(l => JSON.parse(l) as Record<string, unknown>).filter(e => e['level'] === level)

beforeEach(() => {
  tmp = tempDir()
  lines = []
})

afterEach(() => tmp.cleanup())

describe('fichiers qui font tomber le fil', () => {
  it('le journal note la lecture en cours et l oublie une fois finie', () => {
    const q = quarantine()
    q.start(all)
    const journal = join(tmp.dir, 'shard-0.reading.json')
    const g = q.begin('v1', 'f', 'a.png', bytes('x'), 'images@2')
    expect('done' in g).toBe(true)
    expect(JSON.parse(readFileSync(journal, 'utf8')).reading).toHaveLength(1)
    if ('done' in g) g.done()
    expect(existsSync(journal)).toBe(false)
  })

  it('apres trois chutes de suite, le fichier est mis de cote et un rapport d erreur part', () => {
    const content = bytes('image abimee')
    crashWhileReading('f', content)
    crashWhileReading('f', content)
    crashWhileReading('f', content, { error: new Error('Error attempting to read image.') })
    const q = quarantine()
    q.start(all)
    expect(logged('warn').filter(e => String(e['msg']).includes('tombe pendant la lecture'))).toHaveLength(2)
    const [report] = logged('error')
    expect(report).toMatchObject({ vault: 'v1', doc: 'f', ext: 'png', extractor: 'images@2', crashes: 3 })
    expect(report!['err']).toMatchObject({ message: 'Error attempting to read image.' })
    expect(typeof report!['stack']).toBe('string')
    // Ni chemin ni contenu dans le journal du service.
    expect(JSON.stringify(report)).not.toContain('Dossier')
    expect(q.count()).toBe(1)
    expect(q.quarantined('v1', 'f')?.path).toBe('Dossier/f.png')
    expect('quarantined' in q.begin('v1', 'f', 'Dossier/f.png', content, 'images@2')).toBe(true)
  })

  it('relu s il change, si son extracteur change ou apres une nouvelle version du pair', () => {
    const content = bytes('image abimee')
    for (let i = 0; i < 3; i++) crashWhileReading('f', content, { after: 1 })
    const q = quarantine(1)
    q.start(all)
    expect('quarantined' in q.begin('v1', 'f', 'f.png', content, 'images@2')).toBe(true)
    expect('done' in q.begin('v1', 'f', 'f.png', content, 'images@3')).toBe(true)
    expect(q.count()).toBe(0)

    for (let i = 0; i < 2; i++) crashWhileReading('g', content, { after: 1 })
    const later = quarantine(1, 'version-suivante')
    later.start(all)
    expect('done' in later.begin('v1', 'g', 'g.png', content, 'images@2')).toBe(true)
    expect('done' in later.begin('v1', 'h', 'h.png', bytes('autre contenu'), 'images@2')).toBe(true)
  })

  it('une lecture menee a bout entre deux chutes remet le compte a zero', () => {
    const content = bytes('image')
    crashWhileReading('f', content)
    crashWhileReading('f', content)
    const q = quarantine()
    q.start(all)
    const g = q.begin('v1', 'f', 'f.png', content, 'images@2')
    if ('done' in g) g.done()
    crashWhileReading('f', content)
    crashWhileReading('f', content)
    const last = quarantine()
    last.start(all)
    expect(last.count()).toBe(0)
    expect(logged('error')).toHaveLength(0)
  })

  it('un arret propre ne compte pas comme une chute', () => {
    const q = crashWhileReading('f', bytes('x'))
    q.stop()
    const next = quarantine(1)
    next.start(all)
    expect(next.count()).toBe(0)
    expect(logged('warn')).toHaveLength(0)
  })
})

describe('pair indexeur : fichier mis de cote', () => {
  let backend: FakeBackend
  let peer: Peer | undefined

  beforeEach(async () => {
    backend = await new FakeBackend({ token: TOKEN }).start()
  })

  afterEach(async () => {
    await peer?.stop()
    peer = undefined
    await backend.stop()
  })

  it('indexe par son nom seulement, lecture refusee, metrique ; relu quand il change', async () => {
    const csv = bytes('produit,quantite\nmimosa,3\n')
    backend.writeNote('v1', 'n', 'Note.md', 'une note')
    backend.addFile('v1', 'f', 'Ventes.csv', csv)
    // Trois incarnations du fil sont tombees en lisant ce fichier.
    for (let i = 0; i < 3; i++) {
      const q = new FileQuarantine({ dataDir: tmp.dir, shard: 0, version: 'test', after: 3, log: createLogger('silent') })
      q.start(all)
      q.begin('v1', 'f', 'Ventes.csv', csv, `${CSV.id}@${CSV.version}`)
    }
    peer = await startPeer(backend, tmp.dir)
    await until(async () => (await peer!.status('v1')).body.status === 'ready', 10_000, 'construction')
    expect(await peer.found('v1', 'ventes')).toEqual(['f'])
    expect(await peer.found('v1', 'mimosa')).toEqual([])
    expect(await peer.metric('savoire_indexer_quarantined_files')).toBe(1)
    const read = await peer.call('v1', 'documents', 'read', { id: 'f' })
    expect(read.status).toBe(404)
    expect(read.body.error?.message).toContain('mis de cote')

    backend.replaceFile('v1', 'f', bytes('produit,quantite\nmimosa,4\n'))
    await until(async () => (await peer!.found('v1', 'mimosa')).length === 1, 5000, 'fichier change, relu')
    expect(await peer.metric('savoire_indexer_quarantined_files')).toBe(0)
  })
})
