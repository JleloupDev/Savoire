// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Menu « / » d'une note : un document de chaque type (dessin, page...) se
// cree sous la note, avec un lien. Pas seulement des notes.
import { describe, it, expect, vi } from 'vitest'
import { createWikilinksPlugin, newPagePath } from '@savoire/plugin-wikilinks'
import type { FileTypeSpec, PluginAPI, SlashCommandItem } from '@savoire/plugin-api'

const TYPES: FileTypeSpec[] = [
  { extension: 'md', label: 'Note Markdown', icon: 'file-text', collaborationMode: 'crdt', create: async () => '' },
  { extension: 'page', label: 'Page', icon: 'notebook-text', collaborationMode: 'crdt', create: async () => '' },
  { extension: 'excalidraw', label: 'Dessin', icon: 'pen-tool', create: async () => '{"type":"excalidraw"}' },
  { extension: 'png', label: 'Image', icon: 'image', creatable: false, create: async () => '' },
]

describe('menu / : nouveau document de chaque type', () => {
  it('chemin libre sous la note, avec l\'extension du type', () => {
    expect(newPagePath('A/Note.md', ['A/Note/Sans titre.excalidraw'], 'Sans titre', 'excalidraw')).toBe('A/Note/Sans titre 2.excalidraw')
    expect(newPagePath('A/Note.md', [], 'Sans titre')).toBe('A/Note/Sans titre.md')
  })

  it('un item par type creable hors notes ; le choisir cree le document et insere son lien', async () => {
    const slash: SlashCommandItem[] = []
    const files = new Set<string>()
    const createFile = vi.fn(async (p: string) => { files.add(p) })
    const write = vi.fn(async () => {})
    const api = {
      blocks: { register: () => {}, unregister: () => {}, detectBlock: () => null, getAll: () => [] },
      hooks: { beforeParse: () => {} },
      commands: { register: () => {}, unregister: () => {} },
      triggers: { register: () => {}, unregister: () => {}, getAll: () => [], findConflict: () => undefined },
      slash: { register: (i: SlashCommandItem) => slash.push(i), unregister: () => {}, getAll: () => slash },
      files: { register: () => {}, unregister: () => {}, getAll: () => TYPES, resolve: (e: string) => TYPES.find(t => t.extension === e) },
      views: { register: () => {}, unregister: () => {}, getAll: () => [] },
      index: { register: () => {}, registerFactory: () => {}, unregister: () => {}, getAll: () => [], rebuild: () => {} },
      vault: { list: async () => ['A/Note.md'], createFile, write, resolveDocumentId: (p: string) => (files.has(p) ? `id:${p}` : undefined) },
      workspace: { getActiveDocument: () => ({ path: 'A/Note.md' }), notifyVaultChange: () => {} },
    } as unknown as PluginAPI
    await createWikilinksPlugin().onload(api)
    await new Promise(r => setTimeout(r, 10))

    const group = slash.find(i => i.id === 'wikilinks:new-document')!
    const items = group.expand!()
    expect(items.map(i => i.label)).toEqual(['Page', 'Dessin'])
    const drawing = items.find(i => i.label === 'Dessin')!
    const insert = drawing.insert as (ctx: { query: string }) => string
    expect(insert({ query: '' })).toBe('[[A/Note/Sans titre.excalidraw]]')
    await new Promise(r => setTimeout(r, 10))
    expect(createFile).toHaveBeenCalledWith('A/Note/Sans titre.excalidraw')
    expect(write).toHaveBeenCalledWith('id:A/Note/Sans titre.excalidraw', '{"type":"excalidraw"}')
    // Un deuxieme : un autre nom.
    expect(insert({ query: '' })).toBe('[[A/Note/Sans titre 2.excalidraw]]')
  })
})
