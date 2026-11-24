// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import type { VaultAPI } from '@savoire/plugin-api'
import { fileNameForTitle, noteTitle, noteTitleExtension, pathForTitle, renameNoteForTitle, startTitle } from '../../../../../packages/editor-core/src/NoteTitle'

const state = (doc: string) => EditorState.create({ doc })

describe('titre de la note', () => {
  it('est le H1 qui ouvre la note, apres les proprietes', () => {
    expect(noteTitle(state('# Qualité de vie\n\nRetour')).line?.text).toBe('Qualité de vie')
    expect(noteTitle(state('---\ntags: a\n---\n\n# Titre\ntexte')).line?.text).toBe('Titre')
    expect(noteTitle(state('Texte\n# Plus bas')).line).toBeNull()
    expect(noteTitle(state('## Section')).line).toBeNull()
    expect(noteTitle(state('#tag')).line).toBeNull()
  })

  it('donne un nom de fichier propre', () => {
    expect(fileNameForTitle('Plan **2027** : [[Projets/Alpha|Alpha]] / B?')).toBe('Plan 2027 Alpha B')
    expect(fileNameForTitle('Fin.  ')).toBe('Fin')
    expect(fileNameForTitle('***')).toBe('')
  })

  it('garde dossier et extension, evite un nom pris', () => {
    expect(pathForTitle('A/Note.md', 'Nouveau', () => false)).toBe('A/Nouveau.md')
    expect(pathForTitle('A/Note.md', 'Note', () => false)).toBeNull()
    expect(pathForTitle('Note.md', 'Pris', p => p === 'Pris.md')).toBe('Pris 2.md')
  })
})

function makeVault(files: string[]) {
  const docs = new Map(files.map((f, i) => [`id${i}`, f]))
  const moved: { from: string; to: string }[][] = []
  const list = async (dir = '') => {
    const out = new Set<string>()
    for (const p of docs.values()) {
      if (!p.startsWith(dir)) continue
      const rest = p.slice(dir.length)
      const slash = rest.indexOf('/')
      out.add(slash === -1 ? dir + rest : dir + rest.slice(0, slash + 1))
    }
    return [...out].sort()
  }
  const vault = {
    list,
    resolveDocumentId: (p: string) => [...docs].find(([, q]) => q === p)?.[0],
    moveFiles: async (moves: { from: string; to: string }[]) => {
      moved.push(moves)
      for (const m of moves) for (const [id, p] of docs) if (p === m.from) docs.set(id, m.to)
      return 0
    },
    deleteFolder: async () => {},
  } as unknown as VaultAPI
  return { vault, paths: () => [...docs.values()].sort(), moved }
}

describe('renommer pour le titre', () => {
  it('renomme la note et ses sous-pages, par le canal des deplacements', async () => {
    const { vault, paths, moved } = makeVault(['Projet.md', 'Projet/A.md', 'Projet/B/C.md', 'Autre.md'])
    expect(await renameNoteForTitle(vault, 'Projet.md', 'Plan')).toBe('Plan.md')
    expect(paths()).toEqual(['Autre.md', 'Plan.md', 'Plan/A.md', 'Plan/B/C.md'])
    expect(moved).toHaveLength(1)
  })

  it('ne fait rien si le nom ne change pas', async () => {
    const { vault, moved } = makeVault(['Projet.md'])
    expect(await renameNoteForTitle(vault, 'Projet.md', 'Projet')).toBeNull()
    expect(moved).toHaveLength(0)
  })
})

describe('dans l\'editeur', () => {
  function setup(doc: string, path = 'Note.md') {
    const renamed: string[] = []
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage }), noteTitleExtension({ path: () => path, rename: t => renamed.push(t) })] }),
    })
    return { view, renamed, parent }
  }

  it('sans H1, le nom du fichier en filigrane ; un clic en fait le titre', () => {
    const { view, parent } = setup('Du texte', 'Dossier/Ma note.md')
    const ph = parent.querySelector('[data-testid="note-title-placeholder"]')
    expect(ph?.textContent).toBe('Ma note')
    startTitle(view, 'Ma note')
    expect(view.state.doc.toString()).toBe('# Ma note\n\nDu texte')
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('Ma note')
    expect(parent.querySelector('[data-testid="note-title-placeholder"]')).toBeNull()
  })

  it('le fichier suit quand on quitte la ligne du titre, pas avant', () => {
    const { view, renamed } = setup('# Titre\n\ntexte')
    view.focus()
    view.dispatch({ changes: { from: 7, insert: ' neuf' }, selection: { anchor: 12 }, userEvent: 'input.type' })
    expect(renamed).toEqual([])
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    expect(renamed).toEqual(['Titre neuf'])
  })

  it('un changement venu d\'ailleurs ne renomme pas', () => {
    const { view, renamed } = setup('# Titre\n\ntexte')
    view.dispatch({ changes: { from: 7, insert: ' distant' } })
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    expect(renamed).toEqual([])
  })
})
