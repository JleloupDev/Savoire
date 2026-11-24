// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, vi } from 'vitest'
import { selectNeededEntries } from '../../../../../apps/web/src/pluginNeeds'
import { startNeededPlugins } from '../../../../../apps/web/src/neededPlugins'
import type { VaultPlugin } from '@savoire/plugin-api'

// Comme le catalogue : les plugins d'edition de Savoire, un type de fichier, un plugin a declarer.
const CATALOG = [
  ...['plugin-callout', 'plugin-code-block', 'plugin-note-embed', 'plugin-module', 'plugin-task-list', 'plugin-table',
    'plugin-footnotes', 'plugin-base', 'plugin-board', 'plugin-video', 'plugin-mermaid'].map(id => ({ id, editorDefault: true })),
  { id: 'plugin-pdf', extensions: ['pdf'] },
  { id: 'plugin-hashtags' },
  { id: 'plugin-latex', extensions: ['tex'] },
  { id: 'store-chart', editorDefault: true, manifest: { contentPatterns: ['^```chart\\b'] } },
]
const ids = (path: string, text: string, editing = false) => selectNeededEntries(CATALOG, path, text, editing).map(e => e.id)

describe('plugins dont un document a besoin', () => {
  it('une note sans bloc particulier : aucun plugin d edition', () => {
    expect(ids('a.md', 'Du texte, simplement.')).toEqual([])
  })

  it('les traces du texte : un bloc mermaid, un callout, un tableau', () => {
    const found = ids('a.md', '> [!note] Titre\n\n| a | b |\n|---|---|\n\n```mermaid\ngraph TD\n```')
    expect(found).toEqual(expect.arrayContaining(['plugin-callout', 'plugin-table', 'plugin-mermaid', 'plugin-code-block']))
    expect(found).not.toContain('plugin-base')
    expect(found).not.toContain('plugin-board')
  })

  it('le plugin du type de fichier, et ceux que la note declare', () => {
    expect(ids('doc.pdf', '')).toEqual(['plugin-pdf'])
    expect(ids('a.md', '---\nplugins: plugin-hashtags, plugin-latex:lazy\n---\nTexte')).toEqual(expect.arrayContaining(['plugin-hashtags', 'plugin-latex']))
  })

  it('un plugin du store, par les traces de son manifeste', () => {
    expect(ids('a.md', '```chart\ndata\n```')).toContain('store-chart')
    expect(ids('a.md', 'rien')).not.toContain('store-chart')
  })

  it('en edition : tous les outils d edition', () => {
    expect(ids('a.md', 'Du texte', true)).toEqual(expect.arrayContaining(['plugin-callout', 'plugin-table', 'plugin-base', 'plugin-mermaid']))
  })
})

describe('chargement au fil du texte', () => {
  const plugin = (id: string): VaultPlugin => ({ manifest: { id, name: id, version: '1', defaultActive: true } } as VaultPlugin)

  it('charge ce que le texte demande quand il arrive, une seule fois', async () => {
    vi.useFakeTimers()
    const mermaid = plugin('plugin-mermaid')
    const load = vi.fn(async (_path: string, text: string) => ({ editor: text.includes('```mermaid') ? [mermaid] : [], fileTypes: [] }))
    const loadInternal = vi.fn(async () => {})
    const needed = await startNeededPlugins({
      path: 'a.md', editing: false, load, loader: { loadInternal } as never, api: {} as never,
      base: [plugin('plugin-wikilinks')], cancelled: () => false,
    })
    expect(needed.defaultPlugins.map(p => p.manifest.id)).toEqual(['plugin-wikilinks'])
    let onText: ((t: { toString(): string }) => void) | undefined
    const stop = needed.follow({ onTextChange: cb => { onText = cb as never; return () => {} } })
    onText!({ toString: () => 'Un schema\n```mermaid\ngraph TD\n```' })
    onText!({ toString: () => 'Un schema\n```mermaid\ngraph TD; A\n```' })
    await vi.advanceTimersByTimeAsync(200)
    expect(needed.defaultPlugins.map(p => p.manifest.id)).toEqual(['plugin-wikilinks', 'plugin-mermaid'])
    expect(loadInternal).toHaveBeenCalledTimes(2)
    stop()
    vi.useRealTimers()
  })
})
