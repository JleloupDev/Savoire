// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Indexeur de fond du bureau : tout le dossier du vault dans l'index SQLite,
// premiere construction avec progression, reprise sans reconstruction, suivi
// du disque et de l'arborescence. Dossier simule ; SQLite par node:sqlite
// (le pilote natif passe les memes contrats : nativeIndex.test.ts).
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as Y from 'yjs'
import { TREE_ROOT } from '@savoire/indexer-core'
import type { SqlDriver } from '@savoire/indexer-core'
import { NodeSqliteDriver } from '@savoire/indexer-core/node'
import { DirectLocalIndex } from '@savoire/indexer-core/local'
import { DesktopVaultIndexer } from '@savoire/desktop'
import type { FileChange, FileEntry } from '@savoire/platform'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

/** Un dossier de vault en memoire, avec une arborescence de session. */
class FakeVault {
  readonly files = new Map<string, { text?: string; bytes?: Uint8Array; mtime: number }>()
  readonly ids = new Map<string, string>()
  readonly states = new Map<string, Uint8Array>()
  private clock = 1
  private watcher: ((c: FileChange[]) => void) | null = null
  private readonly dirListeners = new Set<() => void>()
  reads = 0

  write(path: string, text: string, id = this.ids.get(path) ?? `id-${path}`): void {
    const created = !this.files.has(path)
    this.files.set(path, { text, mtime: this.clock++ })
    if (created) {
      this.ids.set(path, id)
      for (const cb of this.dirListeners) cb()
    }
    this.watcher?.([{ path, kind: created ? 'created' : 'modified' }])
  }

  /** Document non textuel : son etat CRDT dans .savoire/crdt/<id>/. */
  writeState(path: string, id: string, state: Uint8Array, logName: string): void {
    const created = !this.ids.has(path)
    this.ids.set(path, id)
    this.files.set(path, { text: '', mtime: 0 })
    this.states.set(id, state)
    const log = `.savoire/crdt/${id}/${logName}`
    this.files.set(log, { bytes: state, mtime: this.clock++ })
    if (created) for (const cb of this.dirListeners) cb()
    this.watcher?.([{ path: log, kind: 'created' }])
  }

  move(from: string, to: string): void {
    const f = this.files.get(from)!
    this.files.delete(from)
    this.files.set(to, f)
    this.ids.set(to, this.ids.get(from)!)
    this.ids.delete(from)
    for (const cb of this.dirListeners) cb()
  }

  sources() {
    return {
      fs: {
        list: async (dir: string): Promise<FileEntry[]> => [...this.files]
          .filter(([p]) => !dir || p.startsWith(`${dir}/`))
          .map(([path, f]) => ({ path, kind: 'file' as const, size: (f.text ?? '').length + (f.bytes?.length ?? 0), mtimeMs: f.mtime })),
        stat: async (path: string): Promise<FileEntry | null> => {
          const f = this.files.get(path)
          return f ? { path, kind: 'file', size: (f.text ?? '').length, mtimeMs: f.mtime } : null
        },
        readText: async (path: string) => {
          this.reads++
          const f = this.files.get(path)
          if (!f) throw new Error(`absent : ${path}`)
          return f.text ?? ''
        },
        watch: (cb: (c: FileChange[]) => void) => { this.watcher = cb; return () => { this.watcher = null } },
      },
      directory: {
        getAll: () => [...this.ids].map(([path, id]) => ({ id, path })),
        onChange: (cb: () => void) => { this.dirListeners.add(cb); return () => { this.dirListeners.delete(cb) } },
      },
      readState: async (id: string) => { this.reads++; return this.states.get(id)! },
      stateDirOf: (id: string) => `.savoire/crdt/${id}`,
    }
  }
}

function tempFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'savoire-desk-'))
  dirs.push(d)
  return join(d, 'index.sqlite')
}

function counting(driver: SqlDriver): { driver: SqlDriver; writes: () => number } {
  let n = 0
  return {
    driver: { ...driver, exec: s => driver.exec(s), all: (s, p) => driver.all(s, p), close: () => driver.close(),
      batch: stmts => { if (stmts.some(s => /INTO docs/.test(s.sql))) n++; return driver.batch(stmts) } },
    writes: () => n,
  }
}

function mindmap(topics: string[]): Uint8Array {
  const doc = new Y.Doc()
  const root = doc.getMap(TREE_ROOT)
  topics.forEach((t, i) => {
    const node = new Y.Map()
    node.set('parent', null)
    node.set('order', String(i))
    node.set('topic', t)
    root.set(`node:n${i}`, node)
  })
  return Y.encodeStateAsUpdate(doc)
}

const opts = { debounceMs: 10, batchSize: 7, buildingThreshold: 5 }

describe('DesktopVaultIndexer', () => {
  it('construit tout le vault avec progression, puis reprend sans rien relire', async () => {
    const vault = new FakeVault()
    for (let i = 0; i < 20; i++) vault.write(`Notes/N${i}.md`, `---\nstatut: ${i % 2 ? 'fait' : 'a faire'}\n---\n# Note ${i}\nTexte ${i} [[N${(i + 1) % 20}]] #projet`)
    vault.write('.trash/Vieille.md', 'supprimee')
    vault.write('image.png', 'xx')
    vault.writeState('Carte.mindmap', 'm1', mindmap(['Racine reseau']), '1.bin')
    const file = tempFile()

    const index = await DirectLocalIndex.open(NodeSqliteDriver.open(file), { persistence: 'disk' })
    const states: { status: string; progress?: number }[] = []
    index.onStateChange(s => states.push(s))
    const indexer = new DesktopVaultIndexer(index, vault.sources(), opts)
    indexer.start()
    await indexer.whenIdle()
    expect(states[0]).toEqual({ status: 'building', progress: 0 })
    expect(states.some(s => s.status === 'building' && s.progress! > 0 && s.progress! < 1)).toBe(true)
    expect(states.at(-1)).toEqual({ status: 'ready' })
    const q = await index.queryEngine().query({ from: { notes: true }, where: { field: { prop: 'statut' }, op: 'eq', value: 'fait' } })
    expect(q.total).toBe(10)
    expect((await index.queryEngine().query({ from: { notes: true } })).total).toBe(21)
    expect((await index.searchEngine().search({ text: 'reseau' })).hits.map(h => h.id)).toEqual(['m1'])
    expect(await index.call('tags', 'list', {})).toEqual({ items: [{ tag: 'projet', count: 20 }] })
    expect(await index.call('links', 'backlinks', { id: 'id-Notes/N0.md' })).toMatchObject({ items: [{ id: 'id-Notes/N19.md' }] })
    indexer.dispose()
    await index.close()

    // Redemarrage : rien n'a change, rien n'est relu ni reecrit.
    vault.reads = 0
    const c = counting(NodeSqliteDriver.open(file))
    const again = await DirectLocalIndex.open(c.driver, { persistence: 'disk' })
    expect(again.info.rebuildRequired).toBe(false)
    const indexer2 = new DesktopVaultIndexer(again, vault.sources(), opts)
    indexer2.start()
    await indexer2.whenIdle()
    expect(vault.reads).toBe(0)
    expect(c.writes()).toBe(0)

    // Au fil de l'eau : une note modifiee, une creee, une deplacee, un etat CRDT.
    vault.write('Notes/N3.md', '# Note 3\nnouveau mot clementine')
    vault.write('Nouvelle.md', '# Nouvelle\nkiwi')
    vault.move('Notes/N4.md', 'Archive/N4.md')
    vault.writeState('Carte.mindmap', 'm1', mindmap(['Racine reseau', 'Branche ananas']), '2.bin')
    await indexer2.whenIdle()
    const search = async (t: string) => (await again.searchEngine().search({ text: t })).hits.map(h => h.id)
    expect(await search('clementine')).toEqual(['id-Notes/N3.md'])
    expect(await search('kiwi')).toEqual(['id-Nouvelle.md'])
    expect(await search('ananas')).toEqual(['m1'])
    expect((await again.paths()).get('id-Notes/N4.md')).toBe('Archive/N4.md')
    expect(vault.reads).toBe(4)

    // Une note mise a la corbeille sort de l'index.
    vault.move('Nouvelle.md', '.trash/Nouvelle.md')
    await indexer2.whenIdle()
    expect(await search('kiwi')).toEqual([])
    indexer2.dispose()
    await again.close()
  })

  it('texte d\'une note ouverte : indexe tout de suite', async () => {
    const vault = new FakeVault()
    vault.write('A.md', 'ancien')
    const index = await DirectLocalIndex.open(NodeSqliteDriver.open(':memory:'), { persistence: 'memory' })
    const indexer = new DesktopVaultIndexer(index, vault.sources(), opts)
    indexer.start()
    await indexer.whenIdle()
    indexer.noteText('id-A.md', 'A.md', 'frappe en cours mangue')
    await indexer.whenIdle()
    expect((await index.searchEngine().search({ text: 'mangue' })).total).toBe(1)
    indexer.dispose()
  })

  it('une note illisible est retentee a la passe suivante', async () => {
    const vault = new FakeVault()
    vault.write('A.md', 'pomme')
    const src = vault.sources()
    let fail = true
    const sources = { ...src, fs: { ...src.fs, readText: async (p: string) => { if (fail) throw new Error('verrou'); return src.fs.readText(p) } } }
    const index = await DirectLocalIndex.open(NodeSqliteDriver.open(':memory:'), { persistence: 'memory' })
    const indexer = new DesktopVaultIndexer(index, sources, opts)
    indexer.start()
    await indexer.whenIdle()
    expect((await index.queryEngine().query({ from: { notes: true } })).total).toBe(0)
    fail = false
    vault.write('B.md', 'poire')
    await indexer.whenIdle()
    expect((await index.queryEngine().query({ from: { notes: true } })).total).toBe(2)
    indexer.dispose()
  })
})
