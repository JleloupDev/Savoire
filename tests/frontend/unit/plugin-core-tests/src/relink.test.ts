// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Les liens suivent un deplacement (plugin-api rewriteMovedLinks, plugin-filetree
// relinkAfterMoves), et « /page » range la nouvelle note sous la note courante.
import { describe, it, expect } from 'vitest'
import { createLinkResolver, linkTargetFor, rewriteMovedLinks } from '@savoire/plugin-api'
import { relinkAfterMoves } from '../../../../../packages/plugins/plugin-filetree/src/relink'
import { newPagePath } from '@savoire/plugin-wikilinks'

function ctxFor(before: string[], moves: [string, string][]) {
  const map = new Map(moves)
  const after = before.map(p => map.get(p) ?? p)
  return {
    moves: map,
    before: createLinkResolver(before),
    after: createLinkResolver(after),
    targetFor: (p: string) => linkTargetFor(p, after),
  }
}

describe('les liens suivent un deplacement', () => {
  const before = ['Note.md', 'Note/image.png', 'Autre/image.png', 'Projet.md', 'Docs/plan.md']

  it('un lien par chemin prend le nouveau chemin ; un lien par nom qui trouve encore reste', () => {
    const ctx = ctxFor(before, [['Note/image.png', 'Images/image.png']])
    // « image.png » seul visait Note/image.png (chemin le plus court) ; apres,
    // il trouverait Autre/image.png : il prend le chemin pour garder sa cible.
    expect(rewriteMovedLinks('A ![[Note/image.png]] B ![[image.png|200]]', ctx, 'Note.md'))
      .toBe('A ![[Images/image.png]] B ![[Images/image.png|200]]')
    // Un nom qui trouve encore sa cible reste tel quel.
    const solo = ctxFor(['Note.md', 'Note/photo.png'], [['Note/photo.png', 'Images/photo.png']])
    expect(rewriteMovedLinks('![[photo.png]]', solo, 'Note.md')).toBeNull()
  })

  it('un renommage : le nouveau nom, section, alias et .md gardes', () => {
    const ctx = ctxFor(before, [['Projet.md', 'Archive/Projet 2025.md']])
    expect(rewriteMovedLinks('Voir [[Projet#Titre|le projet]] et [[Projet.md]].', ctx, 'Note.md'))
      .toBe('Voir [[Projet 2025#Titre|le projet]] et [[Projet 2025.md]].')
  })

  it('liens Markdown relatifs, encodes ; code jamais touche', () => {
    const ctx = ctxFor(before, [['Docs/plan.md', 'Archive/Plan final.md']])
    const text = '[plan](Docs/plan.md#a) `[[Docs/plan]]`\n```\n[[Docs/plan]]\n```\n[[Docs/plan]]'
    expect(rewriteMovedLinks(text, ctx, 'Note.md'))
      .toBe('[plan](Archive/Plan%20final.md#a) `[[Docs/plan]]`\n```\n[[Docs/plan]]\n```\n[[Plan final]]')
  })

  it('rien a changer : null', () => {
    const ctx = ctxFor(before, [['Projet.md', 'Archive/Projet.md']])
    expect(rewriteMovedLinks('[[Projet]] et [[Note]]', ctx, 'Note.md')).toBeNull()
  })

  it('relinkAfterMoves : une note renommee avec son dossier, les notes qui les citent suivent', async () => {
    // Apres : Note.md -> Classe/Lecon.md, et son dossier Note/ -> Classe/Lecon/.
    const texts: Record<string, string> = {
      'Classe/Lecon.md': '![[Note/image.png]]',
      'Lecteur.md': 'Lien [[Note]] et image ![[Note/image.png]]',
      'Autre.md': 'Rien ici.',
    }
    const files = [...Object.keys(texts), 'Classe/Lecon/image.png', 'Autre/image.png']
    const vault = {
      list: async (dir?: string) => {
        const d = dir ?? ''
        const out = new Set<string>()
        for (const f of files) {
          if (!f.startsWith(d)) continue
          const rest = f.slice(d.length)
          const slash = rest.indexOf('/')
          out.add(slash < 0 ? f : d + rest.slice(0, slash + 1))
        }
        return [...out]
      },
      readDocumentByPath: async (p: string) => texts[p],
      resolveDocumentId: (p: string) => texts[p] !== undefined ? p : undefined,
      editText: async (id: string, edit: (t: string) => string) => { texts[id] = edit(texts[id]); return true },
    }
    const n = await relinkAfterMoves(vault, [
      { from: 'Note/image.png', to: 'Classe/Lecon/image.png' },
      { from: 'Note.md', to: 'Classe/Lecon.md' },
    ])
    expect(n).toBe(2)
    // Deux image.png dans le vault : le chemin.
    expect(texts['Classe/Lecon.md']).toBe('![[Classe/Lecon/image.png]]')
    expect(texts['Lecteur.md']).toBe('Lien [[Lecon]] et image ![[Classe/Lecon/image.png]]')
    expect(texts['Autre.md']).toBe('Rien ici.')
  })

  it('un lien « dossier/nom » qui trouve encore sa cible apres le deplacement reste', () => {
    const ctx = ctxFor(['Note.md', 'Note/image.png', 'Autre/image.png'], [['Note/image.png', 'Classe/Note/image.png']])
    expect(rewriteMovedLinks('![[Note/image.png]]', ctx, 'Note.md')).toBeNull()
  })
})

describe('/page', () => {
  it('range la page sous la note, nom libre', () => {
    expect(newPagePath('A/Note.md', [])).toBe('A/Note/Nouvelle page.md')
    expect(newPagePath('Note.md', ['Note/Nouvelle page.md', 'note/nouvelle page 2.md'])).toBe('Note/Nouvelle page 3.md')
    expect(newPagePath('Sans extension', [])).toBeNull()
  })
})
