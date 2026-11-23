// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-page : le menu « / » cree tous les types de documents sous la page,
// pas seulement des sous-pages.
import { describe, expect, it, vi } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { FileContext, FileTypeSpec, VaultAPI } from '@savoire/plugin-api'
import { createPageView, fileTypeItems, filterBlocks, pageEditorOf, BLOCK_ITEMS } from '@savoire/plugin-page'
import { pmToInit } from '@savoire/plugin-page/adapter'

const settle = () => new Promise(r => setTimeout(r, 40))

const TYPES: FileTypeSpec[] = [
  { extension: 'md', label: 'Note Markdown', icon: 'file-text', collaborationMode: 'crdt', create: async () => '' },
  { extension: 'page', label: 'Page', icon: 'notebook-text', collaborationMode: 'crdt', create: async () => '' },
  { extension: 'excalidraw', label: 'Dessin', icon: 'pen-tool', create: async () => '{"type":"excalidraw"}' },
  { extension: 'png', label: 'Image', icon: 'image', creatable: false, create: async () => '' },
]

describe('plugin-page — tous les types dans le menu /', () => {
  it('un item par type creable, hors pages et types non creables', () => {
    const items = fileTypeItems(TYPES)
    expect(items.map(i => [i.id, i.fileType])).toEqual([['new-md', 'md'], ['new-excalidraw', 'excalidraw']])
    expect(filterBlocks('dessin', [...BLOCK_ITEMS, ...items]).map(i => i.id)).toEqual(['new-excalidraw'])
  })

  it('« /dessin » cree le dessin sous la page, avec son contenu de depart, et pose sa carte', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bonjour' }] }] }))
    const files = new Set<string>()
    const createFile = vi.fn(async (p: string) => { files.add(p) })
    const write = vi.fn(async () => {})
    const vault = {
      createFile, write,
      list: async () => [...files],
      resolveDocumentId: (p: string) => (files.has(p) ? `id:${p}` : undefined),
    } as unknown as VaultAPI
    const container = document.createElement('div')
    document.body.appendChild(container)
    const view = createPageView('Projet.page', { vaultId: 'v', path: 'Projet.page', tree } as FileContext, { vault, fileTypes: () => TYPES })
    view.mount(container)
    const editor = pageEditorOf(container)!
    await settle()

    editor.chain().focus().setTextSelection(8).splitBlock().insertContent('/dess').run()
    await settle()
    const row = container.querySelector<HTMLElement>('[data-testid="page-slash-new-excalidraw"]')!
    expect(row.textContent).toContain('Dessin')
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    const input = container.querySelector<HTMLInputElement>('[data-testid="page-subpage-name"]')!
    expect(input.placeholder).toContain('Dessin')
    input.value = 'Plan'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await settle()

    expect(createFile).toHaveBeenCalledWith('Projet/Plan.excalidraw')
    expect(write).toHaveBeenCalledWith('id:Projet/Plan.excalidraw', '{"type":"excalidraw"}')
    const link = editor.getJSON().content!.find(n => n.type === 'pageLink')
    expect(link?.attrs?.target).toBe('Projet/Plan.excalidraw')
    const card = container.querySelector<HTMLElement>('[data-testid="page-link-card"]')!
    expect(card.querySelector('.page-link-label')?.textContent).toBe('Plan')
    view.destroy()
  })
})
