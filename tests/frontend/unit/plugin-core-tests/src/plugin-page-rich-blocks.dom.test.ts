// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-page : encadre, bloc repliable, image, tableau et liens vers le vault (ADR-035).
import { describe, expect, it, vi } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { FileContext, VaultAPI } from '@savoire/plugin-api'
import { calloutContent, createPageView, pageEditorOf, pageToMarkdown, tableContent, toggleContent } from '@savoire/plugin-page'
import { pmToInit } from '@savoire/plugin-page/adapter'

const flush = () => new Promise(r => setTimeout(r, 0))

const text = (t: string, marks?: unknown[]) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t })
const p = (t: string) => ({ type: 'paragraph', content: [text(t)] })

const DOC = {
  type: 'doc',
  content: [
    { type: 'callout', attrs: { icon: '⚠️', color: 'red' }, content: [p('Attention')] },
    { type: 'toggle', attrs: { heading: 2 }, content: [{ type: 'toggleTitle', content: [text('Détails')] }, p('Caché')] },
    { type: 'image', attrs: { src: 'Projet/photo.png', alt: 'Une photo' } },
    {
      type: 'table',
      content: [
        { type: 'tableRow', content: [{ type: 'tableCell', attrs: { header: true }, content: [p('Nom')] }, { type: 'tableCell', attrs: { header: true }, content: [p('Prix')] }] },
        { type: 'tableRow', content: [{ type: 'tableCell', content: [p('Logo')] }, { type: 'tableCell', content: [p('300')] }] },
      ],
    },
    { type: 'paragraph', content: [text('Voir '), text('le projet', [{ type: 'link', attrs: { href: 'Projet/Plan' } }])] },
  ],
}

function mount(tree: InMemorySharedTree, vault: Partial<VaultAPI> = {}, openFile = vi.fn()) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const view = createPageView('Projet.page', { vaultId: 'v', path: 'Projet.page', tree } as FileContext, {
    vault: { resolveDocumentId: (path: string) => (path === 'Projet/Plan.page' ? 'id-plan' : null), ...vault } as VaultAPI,
    workspace: { openFile },
  })
  view.mount(container)
  return { container, view, editor: pageEditorOf(container)!, openFile }
}

describe('plugin-page — blocs riches', () => {
  it('lit encadre, bloc repliable, image et tableau depuis l\'arbre', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const resolveAttachmentUrl = vi.fn(async () => 'blob:photo')
    const { container, view } = mount(tree, { resolveAttachmentUrl })
    await flush()
    await flush()
    const callout = container.querySelector('.page-callout')!
    expect(callout.getAttribute('data-color')).toBe('red')
    expect(callout.querySelector('.page-callout-icon')?.textContent).toBe('⚠️')
    expect(callout.textContent).toContain('Attention')
    const toggle = container.querySelector<HTMLElement>('[data-testid="page-toggle"]')!
    expect(toggle.dataset.heading).toBe('2')
    expect(toggle.classList.contains('is-closed')).toBe(true)
    expect(container.querySelectorAll('.page-table th')).toHaveLength(2)
    expect(container.querySelectorAll('.page-table td')).toHaveLength(2)
    expect(resolveAttachmentUrl).toHaveBeenCalledWith('Projet/photo.png')
    expect(container.querySelector<HTMLImageElement>('[data-testid="page-image"] img')?.getAttribute('src')).toBe('blob:photo')
    view.destroy()
  })

  it('replier ou deplier n\'ecrit rien dans la page', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const writes: unknown[] = []
    tree.onChange((_c, info) => writes.push(info))
    const { container, view } = mount(tree)
    await flush()
    const toggle = container.querySelector<HTMLElement>('[data-testid="page-toggle"]')!
    toggle.querySelector('[data-testid="page-toggle-arrow"]')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(toggle.classList.contains('is-closed')).toBe(false)
    await flush()
    expect(writes).toEqual([])
    view.destroy()
  })

  it('un lien vers un document du vault l\'ouvre au clic', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const { container, view, openFile } = mount(tree)
    await flush()
    const a = [...container.querySelectorAll('a')].find(x => x.textContent === 'le projet')!
    expect(a.getAttribute('href')).toBe('Projet/Plan')
    a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(openFile).toHaveBeenCalledWith('Projet/Plan.page')
    view.destroy()
  })

  it('le menu « / » insere un encadre, un bloc repliable, un tableau', async () => {
    const tree = new InMemorySharedTree()
    const { editor, view } = mount(tree)
    await flush()
    editor.commands.insertContent(calloutContent())
    editor.commands.insertContent(toggleContent())
    editor.commands.insertContent(tableContent(2, 2))
    // Le curseur reste dans le bloc insere : les suivants s'y rangent.
    const json = JSON.stringify(editor.getJSON())
    for (const type of ['callout', 'toggle', 'toggleTitle', 'table', 'tableRow', 'tableCell']) expect(json).toContain(`"type":"${type}"`)
    view.destroy()
  })

  it('exporte les blocs riches en Markdown lisible pour l\'index', () => {
    const md = pageToMarkdown(DOC)
    expect(md).toContain('> [!NOTE] ⚠️\n> Attention')
    expect(md).toContain('## Détails\n\nCaché')
    expect(md).toContain('![[Projet/photo.png|Une photo]]')
    expect(md).toContain('| Nom | Prix |\n| --- | --- |\n| Logo | 300 |')
    expect(md).toContain('Voir [[Projet/Plan|le projet]]')
  })
})
