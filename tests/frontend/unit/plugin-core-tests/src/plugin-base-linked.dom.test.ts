// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-base : base integree dans une note, modifiable sur place, avec une
// vue propre a la page.
import { describe, it, expect, vi } from 'vitest'
import { BLOCK_DESTROY_EVENT, parseFrontmatter } from '@savoire/plugin-api'
import { renderLinkedView, retargetEmbed, canLinkView } from '@savoire/plugin-base'
import type { BlockContext } from '@savoire/plugin-api'
import { cell, click, mount, tick, titles, world } from './baseHarness'

const NOTES = [
  { path: 'Projets/Alpha.md', text: '---\nstatus: En cours\n---\n' },
  { path: 'Projets/Beta.md', text: '---\nstatus: Fait\n---\n' },
]

describe('vue liee', () => {
  it('reecrit le lien vers une autre vue, alias garde', () => {
    expect(retargetEmbed('Voir ![[Projets.base#Tableau|ici]] svp', 'Tableau (page)')).toBe('Voir ![[Projets.base#Tableau (page)|ici]] svp')
    expect(retargetEmbed('![[Projets.base]]', 'X')).toBe('![[Projets.base#X]]')
  })

  it('modifiable sur place ; une vue propre a la page ne change pas la base', async () => {
    const w = world(NOTES)
    const a = w.member(0)
    // La base elle-meme, ouverte par un autre onglet.
    const base = await mount(w, 0, a.api)
    await tick(150)
    let line = '![[Projets.base#Tableau]]'
    const ctx = {
      editorView: null,
      edit: vi.fn((_from: number, _to: number, insert: string) => { line = insert }),
      locate: () => ({ from: 0, to: line.length, text: line }),
    } as unknown as BlockContext
    expect(canLinkView(a.api, ctx)).toBe(true)
    expect(canLinkView(a.api, { editorView: null } as BlockContext)).toBe(false)
    const el = renderLinkedView({ path: 'Projets.base', view: 'Tableau' }, a.api, ctx)
    document.body.append(el)
    await tick(200)
    expect(titles(el)).toEqual(['Alpha', 'Beta'])
    // Une cellule se modifie ici.
    const td = cell(el, 'Alpha', 'status')
    td.dispatchEvent(new MouseEvent('dblclick'))
    const input = td.querySelector('[data-testid="base-editor"]') as HTMLInputElement
    input.value = 'Fait'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await tick(100)
    expect(parseFrontmatter(w.notes[0].text).status).toBe('Fait')
    // Vue propre : le lien de la note change, la vue liee n'apparait pas dans la base.
    click(el.querySelector('[data-testid="base-own-view"]'))
    await tick(100)
    expect(line).toBe('![[Projets.base#Tableau (page)]]')
    const tabs = Array.from(base.el.querySelectorAll('[data-testid="base-tab"]')).map(t => t.textContent)
    expect(tabs).toEqual(['▦ Tableau'])
    el.dispatchEvent(new Event(BLOCK_DESTROY_EVENT))
    // Rendu de la nouvelle ligne : la vue liee, ses filtres a elle.
    const el2 = renderLinkedView({ path: 'Projets.base', view: 'Tableau (page)' }, a.api, ctx)
    document.body.append(el2)
    await tick(200)
    expect(el2.querySelector('[data-testid="base-own-view"]')).toBeNull()
    click(el2.querySelector('[data-testid="base-filter"]'))
    click(el2.querySelector('[data-testid="base-filters-add"]'))
    await tick()
    const v = el2.querySelector('[data-testid="base-filters"] [data-testid="base-filter-value"]') as HTMLInputElement
    v.value = 'Alp'
    v.dispatchEvent(new Event('change'))
    await tick(200)
    expect(titles(el2)).toEqual(['Alpha'])
    expect(titles(base.el)).toEqual(['Alpha', 'Beta'])
  })
})
