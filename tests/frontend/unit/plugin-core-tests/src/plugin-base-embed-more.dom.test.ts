// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : une base integree montre 100 lignes, puis « Voir plus ».
import { describe, it, expect } from 'vitest'
import { InMemoryQueryEngine, InMemorySharedTree } from '@savoire/plugin-runtime'
import type { PluginAPI } from '@savoire/plugin-api'
import { parseBaseEmbed, renderBaseEmbed } from '@savoire/plugin-base'

describe('base integree : voir plus', () => {
  it('100 lignes, puis 100 de plus a chaque clic, jusqu a 500', async () => {
    const engine = new InMemoryQueryEngine()
    engine.upsertMany(Array.from({ length: 650 }, (_, i) => ({ id: `d${String(i).padStart(4, '0')}`, path: `Big/N${i}.md`, title: `N${i}`, props: { n: i } })))
    const api = {
      query: engine,
      vault: {
        resolveDocumentId: (p: string) => p === 'Big.base' ? 'B' : undefined,
        list: async () => ['Big.base'],
        openTree: async () => new InMemorySharedTree(),
        closeTree: () => {},
      },
      workspace: { openFile: async () => {} },
    } as unknown as PluginAPI
    const el = renderBaseEmbed(parseBaseEmbed('![[Big.base]]')!, api)
    document.body.appendChild(el)
    const tick = () => new Promise(r => setTimeout(r, 30))
    await tick()
    const rows = () => el.querySelectorAll('[data-testid="base-embed-row"]').length
    const more = () => el.querySelector('[data-testid="base-embed-more"]') as HTMLButtonElement | null
    expect(rows()).toBe(100)
    expect(el.querySelector('[data-testid="base-embed-count"]')!.textContent).toBe('100 / 650 lignes')
    expect(more()!.textContent).toBe('Voir 100 de plus')
    for (let i = 0; i < 4; i++) { more()!.click(); await tick() }
    expect(rows()).toBe(500)
    // Au-dela, la base s'ouvre : plus de bouton.
    expect(more()).toBeNull()
    el.dispatchEvent(new CustomEvent('savoire:block-destroy'))
  })
})
