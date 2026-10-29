// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Extraction d'une note : titre, proprietes typees, texte brut, sections,
// liens, tags, alias. Fonctions pures.
import { describe, it, expect } from 'vitest'
import { extractNote, foldText, parseMarkdownBody, recordText, tokenize, words } from '@savoire/indexer-core'
import { foldText as referenceFold } from '@savoire/plugin-runtime'

const note = (content: string, path = 'Dossier/Ma note.md') => extractNote({ id: 'x', path, content })

describe('repli du texte', () => {
  it('meme regle que le moteur de reference', () => {
    const corpus = ['Électricité À FAIRE', 'Ça va ? Œuvre, naïve, Ærø', 'été', 'İstanbul ß', '東京 Москва', '', '1,5e3']
    for (const s of corpus) expect(foldText(s)).toBe(referenceFold(s))
  })

  it('mots et positions', () => {
    expect(words("L'électricité, c'est 100 % utile")).toEqual(['l', 'electricite', 'c', 'est', '100', 'utile'])
    const t = tokenize('Le réseau')
    expect(t.map(x => [x.start, x.end, x.folded])).toEqual([[0, 2, 'le'], [3, 9, 'reseau']])
  })
})

describe('titre et proprietes', () => {
  it('title du frontmatter, sinon premier H1, sinon le nom du fichier', () => {
    expect(note('---\ntitle: Titre FM\n---\n# Titre H1\n')).toMatchObject({ title: 'Titre FM', titleSource: 'frontmatter' })
    expect(note('Intro\n\n# Titre H1\n\n# Autre\n')).toMatchObject({ title: 'Titre H1', titleSource: 'heading' })
    expect(note('## Seulement un H2\n')).toMatchObject({ title: 'Ma note', titleSource: 'name' })
    expect(note('```\n# pas un titre\n```\n')).toMatchObject({ title: 'Ma note' })
  })

  it('proprietes typees du frontmatter ; dossier, extension', () => {
    const r = note('---\nstatus: En cours\npriority: 2\ndone: false\ndue: 2026-11-03\ntags: [urgent, client]\nvide:\n---\nTexte\n')
    expect(r.props).toEqual({ status: 'En cours', priority: 2, done: false, due: '2026-11-03', tags: ['urgent', 'client'], vide: null })
    expect(r).toMatchObject({ folder: 'Dossier', ext: 'md', path: 'Dossier/Ma note.md' })
  })

  it('un schema force les types', () => {
    const r = extractNote(
      { id: 'x', path: 'a.md', content: '---\nscore: "12"\ncategories: unique\nnom: 42\n---\n' },
      { schema: { properties: [
        { key: 'score', type: 'number' }, { key: 'categories', type: 'multiselect' }, { key: 'nom', type: 'text' },
      ] } })
    expect(r.props).toEqual({ score: 12, categories: ['unique'], nom: '42' })
  })

  it('pas de frontmatter hors des .md, sauf demande', () => {
    expect(note('---\na: 1\n---\nTexte\n', 'plan.outline').props).toEqual({})
    expect(extractNote({ id: 'x', path: 'p.page', content: '---\na: 1\n---\n', frontmatter: true }).props).toEqual({ a: 1 })
  })
})

describe('texte brut et sections', () => {
  it('sans syntaxe Markdown ni frontmatter', () => {
    const r = note('---\na: 1\n---\n**Gras** et _italique_ avec `code`, un [lien](https://x.y), [[Cible|alias]], [[Autre#Partie]] et ![[image.png]].\n')
    expect(recordText(r)).toBe('Gras et italique avec code, un lien, alias, Autre et .')
  })

  it('blocs : listes, taches, citations, encadres, tableaux, regles, commentaires', () => {
    const r = note([
      '- premier', '  1. second', '- [x] fait', '> cite', '> [!note] Encadre', '> dedans',
      '| A | B |', '|---|:-:|', '| 1 | 2 |', '---', 'avant %% cache %% apres', '%%', 'bloc cache', '%%',
      '<span>html</span> <!-- commentaire -->', 'mot_compose et __gras__', 'fin ^bloc-1',
    ].join('\n'))
    expect(recordText(r).split('\n')).toEqual([
      'premier', 'second', 'fait', 'cite', 'Encadre', 'dedans', 'A B', '1 2', 'avant apres', 'html', 'mot_compose et gras', 'fin',
    ])
  })

  it('sections : titre et niveau, texte du titre compris', () => {
    const r = note('Intro\n\n# Un\n\nTexte un\n\n## Deux ##\n\nTexte deux\n')
    expect(r.sections).toEqual([
      { text: 'Intro' },
      { heading: 'Un', level: 1, text: 'Un\nTexte un' },
      { heading: 'Deux', level: 2, text: 'Deux\nTexte deux' },
    ])
  })

  it('le code reste cherchable, mais ne donne ni lien ni tag', () => {
    const r = note('```js\nconst x = "#pasuntag [[PasUnLien]]"\n```\n~~~\n# pas un titre\n~~~\nVrai #tag et `#nontag` [[Lien]]\n')
    expect(recordText(r)).toContain('const x = "#pasuntag [[PasUnLien]]"')
    expect(r.tags).toEqual(['tag'])
    expect(r.links.map(l => l.target)).toEqual(['Lien'])
    expect(r.sections.every(s => s.heading === undefined)).toBe(true)
  })
})

describe('tags et alias', () => {
  it('frontmatter et texte, imbriques, casse ignoree, sans faux positifs', () => {
    const r = note([
      '---', 'tags: [projet, "#Client"]', 'tag: seul', '---',
      '#Projet en tete, #a/b/c, #été, (#pasici) http://site.fr/#ancre [[note#section]]',
      '#2024 n est pas un tag, #y2024 oui, ##double, #fin/',
      '# Titre', 'texte#colle',
    ].join('\n'))
    expect(r.tags).toEqual(['projet', 'Client', 'seul', 'a/b/c', 'été', 'y2024', 'fin'])
  })

  it('alias : liste ou texte', () => {
    expect(note('---\naliases: [Court, "Autre nom"]\n---\n').aliases).toEqual(['Court', 'Autre nom'])
    expect(note('---\nalias: Unique\n---\n').aliases).toEqual(['Unique'])
  })
})

describe('liens', () => {
  it('wikiliens, alias, sections, incrustations, liens Markdown vers des notes', () => {
    const r = parseMarkdownBody([
      '[[Cible]] [[Dossier/Autre|alias]] [[Note#Titre]] [[Note#^bloc|vu]] ![[Incrustee]]',
      '[[#Local]] ![[image.PNG]] [[a\\|b]]',
      '[md](Notes/Page%20deux.md) [rel](../Haut.md#part) [img](photo.png) [web](https://x.fr/a.md) [ancre](#titre) [sans](Projet)',
    ].join('\n'))
    expect(r.links).toEqual([
      { target: 'Cible', embed: false, kind: 'wiki' },
      { target: 'Dossier/Autre', alias: 'alias', embed: false, kind: 'wiki' },
      { target: 'Note', subpath: 'Titre', embed: false, kind: 'wiki' },
      { target: 'Note', subpath: '^bloc', alias: 'vu', embed: false, kind: 'wiki' },
      { target: 'Incrustee', embed: true, kind: 'wiki' },
      { target: 'a', alias: 'b', embed: false, kind: 'wiki' },
      { target: 'Notes/Page deux.md', alias: 'md', embed: false, kind: 'markdown' },
      { target: '../Haut.md', subpath: 'part', alias: 'rel', embed: false, kind: 'markdown' },
      { target: 'Projet', alias: 'sans', embed: false, kind: 'markdown' },
    ])
  })
})
