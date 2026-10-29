// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecrire dans une note hors de son editeur (cellule de base -> frontmatter),
// ouvertures comptees des documents, types des proprietes du vault.
import { describe, it, expect, vi } from 'vitest'
import { InMemorySharedText } from '@savoire/plugin-runtime'
import { setFrontmatterValue } from '@savoire/plugin-api'
import type { ISharedText } from '@savoire/plugin-api'
import {
  NoteTextEditor, VaultPropertyTypes, withDocumentRefCount, documentOpenCount, annexDocId, sessionTrees,
} from '@savoire/application'
import type { IVaultSyncSession } from '@savoire/application'
import { MemChannel } from './helpers/memChannel'

interface FakeDoc { server: InMemorySharedText; client?: InMemorySharedText }

/** Session minimale : le contenu d'un document arrive APRES son ouverture, comme le veut le port. */
function fakeSession(docs: Record<string, string>) {
  const store = new Map<string, FakeDoc>()
  for (const [id, text] of Object.entries(docs)) store.set(id, { server: new InMemorySharedText(text) })
  const opened = new Set<string>()
  const settings = new Map<string, MemChannel>()
  const session = {
    directory: { getAll: () => [], onChange: () => () => {} },
    readDocument: vi.fn(async (id: string) => store.get(id)?.server.toString() ?? ''),
    openDocument: vi.fn((id: string) => {
      opened.add(id)
      const doc = store.get(id) ?? { server: new InMemorySharedText('') }
      store.set(id, doc)
      if (!doc.client) {
        const client = new InMemorySharedText('')
        doc.client = client
        // L'etat connu arrive en changements distants, juste apres l'ouverture.
        const content = doc.server.toString()
        const relay = new InMemorySharedText('')
        InMemorySharedText.link(relay, client)
        InMemorySharedText.link(client, doc.server)
        setTimeout(() => { if (content) relay.applyDelta([{ insert: content }]) }, 5)
      }
      return { getSnapshot: () => new Uint8Array([1]) } as never
    }),
    mergeDocumentState: vi.fn(async () => {}),
    closeDocument: vi.fn((id: string) => {
      opened.delete(id)
      const doc = store.get(id)
      if (doc) doc.client = undefined
    }),
    openText: vi.fn((id: string): ISharedText => {
      const doc = store.get(id)
      if (!doc?.client || !opened.has(id)) throw new Error(`openText : ${id} n'est pas ouvert`)
      return doc.client
    }),
    openVaultSettings: vi.fn((section: string) => {
      let c = settings.get(section)
      if (!c) { c = new MemChannel(); settings.set(section, c) }
      return c
    }),
    registerDocuments: vi.fn(async () => {}),
    openTree: vi.fn(() => ({ root: {} }) as never),
  }
  return { session: session as unknown as IVaultSyncSession, raw: session, store, settings }
}

describe('withDocumentRefCount', () => {
  it('un document ne se ferme qu au dernier closeDocument', () => {
    const { session, raw } = fakeSession({ a: 'x' })
    const counted = withDocumentRefCount(session)
    counted.openDocument('a')
    counted.openDocument('a')
    expect(documentOpenCount(counted, 'a')).toBe(2)
    counted.closeDocument('a')
    expect(raw.closeDocument).not.toHaveBeenCalled()
    counted.closeDocument('a')
    expect(raw.closeDocument).toHaveBeenCalledOnce()
    expect(documentOpenCount(counted, 'a')).toBe(0)
    expect(documentOpenCount(session, 'a')).toBeUndefined()
  })

  it('le reste passe tel quel ; envelopper deux fois rend la meme session', async () => {
    const { session, raw } = fakeSession({ a: 'contenu' })
    const counted = withDocumentRefCount(session)
    expect(withDocumentRefCount(session)).toBe(counted)
    expect(withDocumentRefCount(counted)).toBe(counted)
    expect(await counted.readDocument('a', 'crdt')).toBe('contenu')
    expect(raw.readDocument).toHaveBeenCalledWith('a', 'crdt')
  })
})

describe('NoteTextEditor', () => {
  const NOTE = '---\nstatus: En cours\n---\n# Alpha\nCorps'

  it('attend le contenu, n ecrit que la difference, puis previent pour reindexer', async () => {
    const { session, store } = fakeSession({ n1: NOTE })
    const onEdited = vi.fn()
    const editor = new NoteTextEditor(() => session, { onEdited, keepOpenMs: 10 })
    const deltas: unknown[] = []
    const done = editor.edit('n1', md => setFrontmatterValue(md, 'status', 'Terminé'))
    // Les ecritures qui arrivent chez « les autres » : un seul remplacement.
    await new Promise(r => setTimeout(r, 0))
    store.get('n1')!.server.onChange((d, origin) => { if (origin === 'remote') deltas.push(d) })
    expect(await done).toBe(true)
    expect(store.get('n1')!.server.toString()).toBe(NOTE.replace('En cours', 'Terminé'))
    expect(deltas).toEqual([[{ retain: 12 }, { delete: 8 }, { insert: 'Terminé' }]])
    expect(onEdited).toHaveBeenCalledWith('n1', NOTE.replace('En cours', 'Terminé'))
  })

  it('rien a changer : false, aucune ecriture', async () => {
    const { session } = fakeSession({ n1: NOTE })
    const onEdited = vi.fn()
    const editor = new NoteTextEditor(() => session, { onEdited, keepOpenMs: 10 })
    expect(await editor.edit('n1', md => md)).toBe(false)
    expect(onEdited).not.toHaveBeenCalled()
  })

  it('une note neuve (vide) s ecrit tout de suite', async () => {
    const { session, store, raw } = fakeSession({ neuve: '' })
    const editor = new NoteTextEditor(() => session, { keepOpenMs: 10, emptyWaitMs: 20 })
    await editor.edit('neuve', md => setFrontmatterValue(md, 'priority', 2))
    expect(store.get('neuve')!.server.toString()).toBe('---\npriority: 2\n---\n')
    // Sa synchro n'a peut-etre pas encore demarre : l'etat part aussi par le chemin sur.
    expect(raw.mergeDocumentState).toHaveBeenCalledWith('neuve', new Uint8Array([1]))
  })

  it('garde la note ouverte un moment, puis la ferme ; plusieurs editions la partagent', async () => {
    const { session, raw } = fakeSession({ n1: NOTE })
    const editor = new NoteTextEditor(() => session, { keepOpenMs: 20 })
    await editor.edit('n1', md => setFrontmatterValue(md, 'a', 1))
    await editor.edit('n1', md => setFrontmatterValue(md, 'b', 2))
    expect(raw.openDocument).toHaveBeenCalledOnce()
    expect(raw.closeDocument).not.toHaveBeenCalled()
    await new Promise(r => setTimeout(r, 40))
    expect(raw.closeDocument).toHaveBeenCalledOnce()
  })

  it('un editeur deja ouvert sur la note n est pas coupe', async () => {
    const { session, raw } = fakeSession({ n1: NOTE })
    const counted = withDocumentRefCount(session)
    counted.openDocument('n1') // l'editeur
    const editor = new NoteTextEditor(() => counted, { keepOpenMs: 5 })
    await editor.edit('n1', md => setFrontmatterValue(md, 'a', 1))
    await new Promise(r => setTimeout(r, 20))
    expect(raw.closeDocument).not.toHaveBeenCalled()
    expect(documentOpenCount(counted, 'n1')).toBe(1)
  })

  it('une lecture en retard (vide) n efface pas le vrai contenu : on attend qu il arrive', async () => {
    const { session, raw, store } = fakeSession({ n1: NOTE })
    raw.readDocument.mockResolvedValueOnce('') // cache du profil en retard
    const editor = new NoteTextEditor(() => session, { keepOpenMs: 10, emptyWaitMs: 500 })
    await editor.edit('n1', md => setFrontmatterValue(md, 'priority', 3))
    expect(store.get('n1')!.server.toString()).toBe(NOTE.replace('status: En cours', 'status: En cours\npriority: 3'))
  })

  it('le contenu n arrive jamais : refus, rien n est ecrit', async () => {
    const { session, raw } = fakeSession({})
    raw.readDocument.mockResolvedValueOnce('du texte qui n arrivera pas')
    const editor = new NoteTextEditor(() => session, { loadTimeoutMs: 20, keepOpenMs: 5 })
    await expect(editor.edit('perdue', md => md + 'x')).rejects.toThrow(/pas arrivé/)
  })
})

describe('VaultPropertyTypes', () => {
  it('types partages entre deux membres par les reglages du vault', () => {
    const a = fakeSession({})
    const b = fakeSession({})
    const alice = new VaultPropertyTypes()
    const bob = new VaultPropertyTypes()
    alice.attachVault(a.session)
    bob.attachVault(b.session)
    MemChannel.link(a.settings.get('properties')!, b.settings.get('properties')!)
    const seen = vi.fn()
    bob.onChange(seen)
    alice.set({ key: 'priority', type: 'number' })
    alice.set({ key: 'status', type: 'select', options: [{ value: 'En cours', color: 'blue' }] })
    expect(bob.get('priority')).toEqual({ key: 'priority', type: 'number' })
    expect(bob.get('status')?.options).toEqual([{ value: 'En cours', color: 'blue' }])
    expect(bob.schema().properties.map(p => p.key).sort()).toEqual(['priority', 'status'])
    expect(seen).toHaveBeenCalled()
    bob.remove('priority')
    expect(alice.get('priority')).toBeUndefined()
  })

  it('une valeur illisible est ignoree ; sans vault, set echoue', () => {
    const s = fakeSession({})
    const types = new VaultPropertyTypes()
    expect(() => types.set({ key: 'x', type: 'text' })).toThrow()
    types.attachVault(s.session)
    s.settings.get('properties')!.set('bad', { type: 'inconnu' })
    expect(types.get('bad')).toBeUndefined()
  })
})

describe('arbres annexes', () => {
  it('id derive du document et du nom ; inscrit avant ouverture quand on ecrit', async () => {
    const { session, raw } = fakeSession({})
    const trees = sessionTrees(session)
    expect(annexDocId('base-1', 'lot-007')).toBe('base-1~lot-007')
    await trees.openAnnex('base-1', 'lot-007', { create: true })
    expect(raw.registerDocuments).toHaveBeenCalledWith(['base-1~lot-007'])
    expect(raw.openDocument).toHaveBeenCalledWith('base-1~lot-007')
    await trees.openAnnex('base-1', 'lot-008')
    expect(raw.registerDocuments).toHaveBeenCalledOnce()
  })
})
