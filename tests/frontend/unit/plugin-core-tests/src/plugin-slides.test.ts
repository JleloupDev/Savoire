// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des presentations : plan, et reglages (transitions,
// apparitions, decor, fond, image de fond) pour toute la presentation ou une
// diapositive. Dans l'appli et par le MCP du serveur.
import { describe, it, expect, vi } from 'vitest'
import { slideDeck, TEXT_PROPOSAL, type PluginAPI, type ToolContext } from '@savoire/plugin-api'
import { slidesAgentTools } from '@savoire/plugin-slides'

const actor = { agentId: 'a', agentName: 'Mise en page', onBehalfOf: { userId: 'u', displayName: 'Jean' } }
const ctx = (mode: 'direct' | 'propose' = 'direct') => ({ mode, actor } as unknown as ToolContext)

const DECK = '---\ntype: slides\n---\n# Cours\n\n---\n\n## Partie 1\n\n- un\n- deux\n\n. . .\n\nConclusion\n\nNotes : rappel\n\n---\n\n## Fin\n'

function setup(initial = DECK) {
  const files = new Map<string, { id: string; text: string }>([
    ['Cours.md', { id: 'n1', text: initial }],
    ['Simple.md', { id: 'n2', text: '# Pas une présentation\n' }],
  ])
  const byId = () => new Map([...files].map(([path, f]) => [f.id, { path, ...f }]))
  const propose = vi.fn(async () => 'p1')
  const api = {
    vault: {
      getFileTree: () => [...files].map(([path, f]) => ({ docId: f.id, path })),
      resolveDocumentId: (p: string) => files.get(p)?.id,
      read: async (id: string) => byId().get(id)!.text,
      editText: async (id: string, edit: (s: string) => string) => { const f = byId().get(id)!; files.get(f.path)!.text = edit(f.text); return true },
    },
    review: { propose },
  } as unknown as PluginAPI
  const tools = Object.fromEntries(slidesAgentTools(api).map(t => [t.spec.name, t]))
  const text = () => files.get('Cours.md')!.text
  return { tools, text, propose }
}

describe('outils des presentations', () => {
  it('declare des outils pour le serveur (MCP) aussi', () => {
    const { tools } = setup()
    expect(Object.keys(tools)).toEqual(['slides_outline', 'slides_style'])
    for (const t of Object.values(tools)) expect(t.spec.runtimes).toEqual(['app', 'server'])
  })

  it('donne le plan, avec les clics d apparition et les notes', async () => {
    const { tools } = setup()
    const r = await tools.slides_outline!.run({ note: 'Cours' }, ctx())
    expect(r.text).toContain('3 diapositive(s)')
    expect(r.text).toContain('transition aucune')
    expect(r.text).toContain('1. Cours : diapositive de titre')
    expect(r.text).toContain('2. Partie 1 : 1 clic(s) d’apparition, notes du présentateur')
    expect((await tools.slides_outline!.run({ note: 'Simple' }, ctx())).text).toMatch(/pas une présentation/)
  })

  it('regle toute la presentation dans ses proprietes', async () => {
    const { tools, text } = setup()
    const r = await tools.slides_style!.run({ note: 'Cours', transition: 'fondu', decor: 'formes', builds: true, theme: 'sombre' }, ctx())
    expect(r.text).toMatch(/^Réglé pour Cours\.md/)
    const deck = slideDeck(text())
    expect(deck).toMatchObject({ transition: 'fondu', decor: 'formes', builds: true, theme: 'sombre' })
    expect(text()).toContain('apparition: listes')
    // Avec les listes une par une : 2 points + le passage apres « . . . ».
    expect((await tools.slides_outline!.run({ note: 'Cours' }, ctx())).text).toContain('3 clic(s)')
    await expect(tools.slides_style!.run({ note: 'Cours', transition: 'tourbillon' }, ctx())).rejects.toThrow(/Possibles : aucune, fondu/)
    await expect(tools.slides_style!.run({ note: 'Cours', image: 'x.jpg' }, ctx())).rejects.toThrow(/donnez slide/)
    await expect(tools.slides_style!.run({ note: 'Simple', transition: 'zoom' }, ctx())).rejects.toThrow(/type: slides/)
  })

  it('regle une diapositive : reglages, fond, image ; puis les retire', async () => {
    const { tools, text } = setup()
    await tools.slides_style!.run({ note: 'Cours', slide: 2, transition: 'zoom', background: '#1e3a5f', image: 'Images/photo.jpg', image_side: 'gauche' }, ctx())
    expect(text()).toContain('---\n\n<!-- transition: zoom; fond: #1e3a5f -->\n![[Images/photo.jpg|fond gauche]]\n## Partie 1')
    let s = slideDeck(text()).slides[1]!
    expect(s.title).toBe('Partie 1')
    expect(s.options).toMatchObject({ transition: 'zoom', background: '#1e3a5f' })
    expect(s.image).toEqual({ markdown: '![[Images/photo.jpg]]', side: 'gauche' })
    expect(s.notes).toBe('rappel')
    // Une seule ligne de reglages, completee ; l'image change de cote.
    await tools.slides_style!.run({ note: 'Cours', slide: 2, effect: 'montée', image_side: 'droite' }, ctx())
    expect(text().match(/<!--/g)).toHaveLength(1)
    s = slideDeck(text()).slides[1]!
    expect(s.options).toMatchObject({ transition: 'zoom', effect: 'montée' })
    expect(s.image?.side).toBe('droite')
    await tools.slides_style!.run({ note: 'Cours', slide: 2, transition: null, background: '', effect: '', image: '' }, ctx())
    expect(text()).toBe(DECK)
    await expect(tools.slides_style!.run({ note: 'Cours', slide: 9, transition: 'zoom' }, ctx())).rejects.toThrow(/3 diapositive\(s\)/)
    await expect(tools.slides_style!.run({ note: 'Cours', slide: 2, background: 'url(x)' }, ctx())).rejects.toThrow(/Couleur de fond invalide/)
  })

  it('propose le changement en mode revision', async () => {
    const { tools, text, propose } = setup()
    const r = await tools.slides_style!.run({ note: 'Cours', slide: 1, decor: 'bande' }, ctx('propose'))
    expect(r.text).toMatch(/proposés/)
    expect(text()).toBe(DECK)
    expect(propose).toHaveBeenCalledWith('n1', TEXT_PROPOSAL, expect.anything(), expect.stringContaining('Mise en page'))
  })
})
