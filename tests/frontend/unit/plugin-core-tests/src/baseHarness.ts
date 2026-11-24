// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Banc d'essai des bases (meme montage que plugin-base.dom.test.ts) : un
// vault partage par deux membres, le vrai fournisseur de requetes de l'appli
// (QueryEngineProvider + InMemoryQueryEngine), et la vue d'un fichier .base.
import { vi } from 'vitest'
import plugin from '@savoire/plugin-base'
import { InMemoryQueryEngine, InMemorySharedTree } from '@savoire/plugin-runtime'
import { QueryEngineProvider, VaultPropertyTypes, annexDocId } from '@savoire/application'
import type { IVaultSyncSession, QueryVaultSources } from '@savoire/application'
import { parseFrontmatter } from '@savoire/plugin-api'
import type { FileContext, FileTypeSpec, IIndexChannel, PluginAPI, VaultAPI } from '@savoire/plugin-api'

export interface Note { id: string; path: string; text: string }

class Channel implements IIndexChannel {
  private readonly map = new Map<string, unknown>()
  private readonly cbs = new Set<(ids: string[]) => void>()
  set(id: string, v: unknown) { this.map.set(id, v); for (const cb of [...this.cbs]) cb([id]) }
  delete(id: string) { this.map.delete(id); for (const cb of [...this.cbs]) cb([id]) }
  getAll() { return [...this.map].map(([id, value]) => ({ id, value })) }
  onChange(cb: (ids: string[]) => void) { this.cbs.add(cb); return () => { this.cbs.delete(cb) } }
  dispose() {}
}

export const tick = (ms = 60) => new Promise(r => setTimeout(r, ms))

/** Un vault partage par deux membres : memes notes, arbres de la base et lots relies. */
export function world(initial: Omit<Note, 'id'>[], bases: { id: string; path: string }[] = []) {
  let counter = 0
  const notes: Note[] = initial.map(n => ({ ...n, id: `n${++counter}` }))
  notes.push({ id: 'base1', path: 'Projets.base', text: '' })
  for (const b of bases) notes.push({ ...b, text: '' })
  const changed = new Set<() => void>()
  const notify = () => { for (const cb of [...changed]) cb() }
  const settings = new Channel()
  const trees = new Map<string, InMemorySharedTree[]>()
  const treePair = (id: string) => {
    let p = trees.get(id)
    if (!p) { p = [new InMemorySharedTree(), new InMemorySharedTree()]; InMemorySharedTree.link(p[0], p[1]); trees.set(id, p) }
    return p
  }
  const editText = vi.fn(async (id: string, fn: (s: string) => string) => {
    const note = notes.find(n => n.id === id)!
    const next = fn(note.text)
    if (next === note.text) return false
    note.text = next
    notify()
    return true
  })
  const vault = {
    resolveDocumentId: (path: string) => notes.find(n => n.path === path)?.id,
    editText,
    createFile: vi.fn(async (path: string) => { notes.push({ id: `n${++counter}`, path, text: '' }); notify() }),
    renameFile: vi.fn(async (id: string, path: string) => { notes.find(n => n.id === id)!.path = path; notify() }),
    deleteFile: vi.fn(async (id: string) => { const i = notes.findIndex(n => n.id === id); if (i >= 0) notes.splice(i, 1); notify() }),
    getCurrentUser: () => ({ id: 'u1', name: 'Alice' }),
    read: async (id: string) => notes.find(n => n.id === id)?.text ?? '',
    getFileTree: () => notes.map(n => ({ docId: n.id, path: n.path, crdtVersion: { clock: 0 } })),
    openTree: async (id: string) => treePair(id)[0],
    closeTree: () => {},
  } as unknown as VaultAPI

  function member(peer: 0 | 1) {
    const session = {
      directory: { getAll: () => notes.map(n => ({ id: n.id, path: n.path })), onChange: (cb: () => void) => { changed.add(cb); return () => changed.delete(cb) } },
      readDocument: async (id: string) => notes.find(n => n.id === id)?.text ?? '',
      openVaultSettings: () => settings,
    } as unknown as IVaultSyncSession
    const types = new VaultPropertyTypes()
    types.attachVault(session)
    types.setMembersSource(async () => [{ id: 'u1', name: 'Alice' }, { id: 'u2', name: 'Bob' }])
    const sources: QueryVaultSources = {
      session,
      metadata: {
        getAll: () => notes.filter(n => n.path.endsWith('.md')).map(n => ({
          docId: n.id, path: n.path, crdtVersion: { clock: 0 }, title: '', tags: [], aliases: [], frontmatter: parseFrontmatter(n.text),
        })),
        onChange: cb => { changed.add(cb); return () => changed.delete(cb) },
      },
      types,
      trees: {
        open: async id => treePair(id)[peer],
        close: () => {},
        openAnnex: async (id, name) => treePair(annexDocId(id, name))[peer],
        closeAnnex: () => {},
      },
    }
    const query = new QueryEngineProvider(() => new InMemoryQueryEngine())
    query.attachVault(sources)
    const opened = vi.fn()
    const api = {
      query, properties: types, vault,
      workspace: { openFile: opened },
      files: { register: () => {} },
      commands: { register: () => {} },
    } as unknown as PluginAPI
    return { api, query, types, opened }
  }
  return { notes, vault, editText, member, tree: (id: string, peer: 0 | 1) => treePair(id)[peer], notify }
}

export async function spec(): Promise<FileTypeSpec> {
  const specs: FileTypeSpec[] = []
  await plugin.onload({ files: { register: (s: FileTypeSpec) => specs.push(s) }, commands: { register: () => {} } } as unknown as PluginAPI)
  return specs[0]
}

export async function mount(w: ReturnType<typeof world>, peer: 0 | 1, api: PluginAPI, base = { id: 'base1', path: 'Projets.base' }) {
  const s = await spec()
  // Le plugin garde l'API recue au chargement : on recharge avec celle du membre.
  await plugin.onload({ ...api, files: { register: () => {} }, commands: { register: () => {} } } as unknown as PluginAPI)
  const ctx: FileContext = {
    vaultId: 'v', path: base.path, tree: w.tree(base.id, peer), vault: w.vault,
    shared: {
      openMap: () => { throw new Error('inutile') },
      openTree: async name => w.tree(annexDocId(base.id, name), peer),
      closeTree: () => {},
    },
  }
  const el = document.createElement('div')
  document.body.appendChild(el)
  const view = s.open!(base.path, ctx)
  view.mount(el)
  return { el, view, ctx }
}

export const titles = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="base-row"] [data-testid="base-title"]')).map(n => n.textContent)
export const click = (el: Element | null) => (el as HTMLElement).click()
export const cell = (el: HTMLElement, rowTitle: string, key: string) => {
  const row = Array.from(el.querySelectorAll('[data-testid="base-row"]')).find(r => r.querySelector('[data-testid="base-title"]')?.textContent === rowTitle)!
  return row.querySelector(`[data-key="${key}"]`) as HTMLElement
}
export function typeIn(host: HTMLElement, value: string) {
  const input = host.querySelector('[data-testid="base-editor"]') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
}

