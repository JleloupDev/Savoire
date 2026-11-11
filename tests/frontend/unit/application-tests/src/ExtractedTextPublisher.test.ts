// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Texte extrait sur le poste (plugins non officiels), publie dans l'annexe
// « texte » du fichier pour que le serveur l'indexe.
import { describe, it, expect, vi } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { ExtractorSpec } from '@savoire/plugin-api'
import { ExtractedTextPublisher } from '@savoire/application'
import type { IVaultSyncSession } from '@savoire/application'

function fakeSession(files: { id: string; path: string; binary?: boolean }[]) {
  const trees = new Map<string, InMemorySharedTree>()
  const session = {
    directory: { getAll: () => files, onChange: () => () => {} },
    files: { readBytes: vi.fn(async (id: string) => ({ bytes: new TextEncoder().encode(`contenu de ${id}`) })) },
    registerDocuments: vi.fn(async () => {}),
    openDocument: vi.fn(() => ({ getSnapshot: () => new Uint8Array([1]) })),
    closeDocument: vi.fn(),
    mergeDocumentState: vi.fn(async () => {}),
    openTree: vi.fn((id: string) => {
      let t = trees.get(id)
      if (!t) trees.set(id, t = new InMemorySharedTree())
      return t
    }),
  }
  return { session: session as unknown as IVaultSyncSession, raw: session, trees }
}

const spec = (over: Partial<ExtractorSpec> = {}): ExtractorSpec => ({
  id: 'sketch', label: 'Sketch', extensions: ['sketch'], version: 1,
  extract: async bytes => ({ sections: [{ text: new TextDecoder().decode(bytes) }] }),
  ...over,
})

describe('ExtractedTextPublisher', () => {
  it('publie le texte des fichiers lus par un plugin non officiel, une seule fois', async () => {
    const { session, raw, trees } = fakeSession([
      { id: 'f', path: 'Plans/A.sketch', binary: true },
      { id: 'n', path: 'Note.md' },
      { id: 'c', path: 'Croquis.sketch' },
      { id: 'p', path: 'Doc.pdf', binary: true },
      { id: 't', path: '.trash/B.sketch', binary: true },
    ])
    const extractors: Record<string, ExtractorSpec> = { sketch: spec(), pdf: spec({ id: 'pdf', official: true }) }
    const pub = new ExtractedTextPublisher(session, path => extractors[path.split('.').pop()!], () => true, { settleMs: 5 })
    expect(await pub.pass()).toBe(1)
    const annex = trees.get('f~texte')!
    expect(String(annex.root.get('markdown'))).toContain('contenu de f')
    expect(annex.root.get('extractor')).toBe('sketch@1')
    // Officiel (le serveur s'en charge), document CRDT, corbeille : rien.
    expect([...trees.keys()]).toEqual(['f~texte'])
    expect(raw.registerDocuments).toHaveBeenCalledWith(['f~texte'])
    // Ecrit par le chemin qui ne perd rien, puis ferme.
    expect(raw.mergeDocumentState).toHaveBeenCalledWith('f~texte', expect.any(Uint8Array))
    expect(raw.closeDocument).toHaveBeenCalledWith('f~texte')

    expect(await pub.pass()).toBe(0)
    expect(raw.files.readBytes).toHaveBeenCalledOnce()
  })

  it('ne relit pas un fichier dont le texte est deja publie par un autre membre', async () => {
    const { session, raw, trees } = fakeSession([{ id: 'f', path: 'A.sketch', binary: true }])
    const pub = new ExtractedTextPublisher(session, () => spec(), () => true, { settleMs: 200 })
    raw.openTree.mockImplementationOnce((id: string) => {
      const t = new InMemorySharedTree()
      trees.set(id, t)
      // Le contenu connu arrive juste apres l'ouverture.
      setTimeout(() => t.root.set('extractor', 'sketch@1'), 10)
      return t
    })
    expect(await pub.pass()).toBe(0)
    expect(raw.files.readBytes).not.toHaveBeenCalled()
  })

  it('republie quand l extracteur change de version ; rien en lecture seule', async () => {
    const { session, raw } = fakeSession([{ id: 'f', path: 'A.sketch', binary: true }])
    let current = spec()
    let writable = false
    const pub = new ExtractedTextPublisher(session, () => current, () => writable, { settleMs: 5 })
    expect(await pub.pass()).toBe(0)
    expect(raw.files.readBytes).not.toHaveBeenCalled()
    writable = true
    expect(await pub.pass()).toBe(1)
    current = spec({ version: 2 })
    expect(await pub.pass()).toBe(1)
    expect(raw.files.readBytes).toHaveBeenCalledTimes(2)
  })
})
