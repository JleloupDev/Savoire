// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ce qu'on reprend d'Obsidian : insertion d'un modele (proprietes fusionnees),
// note du jour precedente / suivante, types `tags` et `aliases`, suivre un lien.
import { describe, it, expect } from 'vitest'
import { insertTemplate, mergeTemplateProperties, splitTemplate } from '@savoire/plugin-templates'
import { adjacentDailyNote } from '@savoire/plugin-agenda'
import { linkUnderCursor } from '@savoire/plugin-wikilinks'
import { coercePropertyValue, isListType, propertyTypeOf } from '@savoire/plugin-api'

describe('modeles', () => {
  it('separe les proprietes du corps', () => {
    expect(splitTemplate('---\ntype: réunion\n---\n## Ordre du jour\n')).toEqual({ properties: [['type', 'réunion']], body: '## Ordre du jour\n' })
    expect(splitTemplate('Sans propriétés')).toEqual({ properties: [], body: 'Sans propriétés' })
  })

  it('ajoute les proprietes absentes, garde celles de la note', () => {
    const note = '---\ntype: projet\n---\nTexte'
    expect(mergeTemplateProperties(note, [['type', 'réunion'], ['lieu', 'Paris']])).toBe('---\ntype: projet\nlieu: Paris\n---\nTexte')
  })

  it('insere le corps au curseur et place le curseur apres', () => {
    const r = insertTemplate('Avant\n', 6, '---\nlieu: Paris\n---\nCorps\n')
    expect(r.text).toBe('---\nlieu: Paris\n---\nAvant\nCorps\n')
    expect(r.text.slice(0, r.cursor)).toBe('---\nlieu: Paris\n---\nAvant\nCorps\n')
  })
})

describe('notes du jour', () => {
  const files = ['Journal/2026-11-20.md', 'Journal/2026-11-25.md', '2026-11-27.md', 'Autre.md']
  it('va a la note du jour existante precedente ou suivante', () => {
    expect(adjacentDailyNote(files, 'Journal/2026-11-25.md', -1)).toBe('Journal/2026-11-20.md')
    expect(adjacentDailyNote(files, 'Journal/2026-11-25.md', 1)).toBe('2026-11-27.md')
    expect(adjacentDailyNote(files, '2026-11-27.md', 1)).toBeNull()
    expect(adjacentDailyNote(files, 'Autre.md', 1)).toBeNull()
  })
})

describe('types tags et aliases', () => {
  it('tags et aliases ont leur type par leur nom, sauf declaration', () => {
    expect(propertyTypeOf(undefined, 'tags', ['a'])).toBe('tags')
    expect(propertyTypeOf(undefined, 'aliases', 'Autre nom')).toBe('aliases')
    expect(propertyTypeOf({ get: () => ({ key: 'tags', type: 'text' }) }, 'tags', 'x')).toBe('text')
    expect(isListType('tags')).toBe(true)
    expect(isListType('aliases')).toBe(true)
  })

  it('une valeur de tags devient une liste sans #', () => {
    expect(coercePropertyValue('#projet, #client', 'tags')).toEqual(['projet', 'client'])
    expect(coercePropertyValue(['#a', 'b'], 'tags')).toEqual(['a', 'b'])
    expect(coercePropertyValue('Mon autre nom', 'aliases')).toEqual(['Mon autre nom'])
  })
})

describe('suivre le lien sous le curseur', () => {
  it('lien wiki, lien Markdown, adresse nue', () => {
    expect(linkUnderCursor('voir [[Projet#Plan|le plan]] ici', 8)).toEqual({ page: 'Projet', subpath: 'Plan' })
    expect(linkUnderCursor('voir [doc](Dossier/Note%20A.md) ici', 10)).toEqual({ page: 'Dossier/Note A', subpath: '' })
    expect(linkUnderCursor('site https://example.org/a fin', 10)).toEqual({ page: '', subpath: '', external: 'https://example.org/a' })
    expect(linkUnderCursor('[x](https://e.org)', 2)?.external).toBe('https://e.org')
    expect(linkUnderCursor('rien ici', 3)).toBeNull()
  })
})
