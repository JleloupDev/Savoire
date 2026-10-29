// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lecture des CRDT pour le pair indexeur : arborescence du vault et contenu
// indexable de chaque type de document, depuis des journaux Yjs en base 64
// (forme de l'API interne). Les documents sont ecrits avec le code des
// clients (YMapVaultDirectory, YjsSharedTree, plugins page et carte mentale).
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  diffTree, extractNote, noteInputFromUpdates, readDocContent, recordText, vaultTreeFromUpdates, withDoc,
} from '@savoire/indexer-core'
import { YMapVaultDirectory } from '../../../../../packages/infrastructure-sync/src/YMapVaultDirectory'
import { YjsSharedTree } from '../../../../../packages/infrastructure-sync/src/YjsSharedTree'
import { pmToInit } from '../../../../../packages/plugins/plugin-page/src/adapter/convert'
import type { PmJson } from '../../../../../packages/plugins/plugin-page/src/adapter/convert'
import { writeAll } from '../../../../../packages/plugins/plugin-mindmap/src/model'

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64')

/** Un Y.Doc dont on garde le journal des mises a jour, comme le serveur. */
function journaled(): { doc: Y.Doc; log: string[] } {
  const doc = new Y.Doc()
  const log: string[] = []
  doc.on('update', (u: Uint8Array) => log.push(b64(u)))
  return { doc, log }
}

describe('arborescence du vault', () => {
  it('lue depuis le journal ecrit par YMapVaultDirectory (etat complet puis increments)', () => {
    const dir = new YMapVaultDirectory()
    const log: string[] = []
    dir.add({ id: 'a', path: 'Notes/A.md' })
    dir.add({ id: 'b', path: 'B.page' })
    dir.addFolder('Vide')
    log.push(b64(dir.encodeFullState()))
    const stop = dir.onLocalUpdate(u => log.push(b64(u)))
    dir.rename('a', 'Archives/A.md')
    dir.add({ id: 'c', path: '.trash/C.md' })
    dir.remove('b')
    stop()

    const tree = vaultTreeFromUpdates(log)
    expect([...tree.docs]).toEqual([['a', 'Archives/A.md'], ['c', '.trash/C.md']])
    expect(tree.folders).toEqual(['Vide'])
    dir.dispose()
  })

  it('ce qui change entre l index et l arbre', () => {
    const before = new Map([['a', 'A.md'], ['b', 'B.md'], ['c', 'C.md']])
    const after = new Map([['a', 'A.md'], ['b', 'Dossier/B.md'], ['d', 'D.md']])
    expect(diffTree(before, after)).toEqual({
      added: [{ id: 'd', path: 'D.md' }],
      removed: ['c'],
      moved: [{ id: 'b', from: 'B.md', to: 'Dossier/B.md' }],
    })
  })
})

describe('contenu des documents', () => {
  it('.md : le texte partage, frontmatter compris', () => {
    const { doc, log } = journaled()
    const text = doc.getText('codemirror')
    text.insert(0, '---\nstatus: fait\n---\n# Titre\n\nCorps')
    text.insert(text.length, ' modifie #tag')
    const input = noteInputFromUpdates('n', 'Notes/N.md', log)!
    expect(input).toEqual({ id: 'n', path: 'Notes/N.md', content: '---\nstatus: fait\n---\n# Titre\n\nCorps modifie #tag', frontmatter: true })
    const r = extractNote(input)
    expect(r).toMatchObject({ title: 'Titre', props: { status: 'fait' }, tags: ['tag'] })
  })

  it('.outline : le texte, sans proprietes', () => {
    const { doc, log } = journaled()
    doc.getText('codemirror').insert(0, '- Projet\n  - [ ] tache [[Lien]]\n')
    const r = extractNote(noteInputFromUpdates('o', 'Plan.outline', log)!)
    expect(recordText(r)).toBe('Projet\ntache Lien')
    expect(r.links.map(l => l.target)).toEqual(['Lien'])
  })

  it('.page : l arbre partage ecrit par plugin-page, en Markdown (titres, listes, liens, sous-pages)', () => {
    const { doc, log } = journaled()
    const page: PmJson = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Compte rendu' }] },
        { type: 'paragraph', content: [
          { type: 'text', text: 'Voir ' },
          { type: 'text', text: 'le site', marks: [{ type: 'link', attrs: { href: 'https://exemple.fr' } }] },
          { type: 'text', text: ' et ' },
          { type: 'text', text: 'du code', marks: [{ type: 'code' }] },
          { type: 'hardBreak' },
          { type: 'text', text: 'ligne deux #reunion', marks: [{ type: 'bold' }] },
        ] },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Actions' }] },
        { type: 'bulletList', content: [
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'appeler' }] }] },
          { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ecrire' }] }] },
        ] },
        { type: 'pageLink', attrs: { target: 'Projets/Sous page' } },
        { type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] },
      ],
    }
    new YjsSharedTree(doc).root.set('doc', pmToInit(page))
    const input = noteInputFromUpdates('p', 'Projets/Reunion.page', log)!
    expect(input.frontmatter).toBe(false)
    const r = extractNote(input)
    expect(r.title).toBe('Compte rendu')
    expect(r.sections.map(s => s.heading)).toEqual(['Compte rendu', 'Actions'])
    expect(recordText(r)).toBe('Compte rendu\nVoir le site et du code\nligne deux #reunion\nActions\nappeler\necrire\nProjets/Sous page\nx = 1')
    expect(r.links.map(l => l.target)).toEqual(['Projets/Sous page'])
    expect(r.tags).toEqual(['reunion'])
  })

  it('.excalidraw : les textes visibles, dans l ordre d affichage', () => {
    const { doc, log } = journaled()
    const tree = new YjsSharedTree(doc)
    const el = (id: string, extra: object) => JSON.stringify({ id, version: 1, versionNonce: 1, ...extra })
    tree.transact(() => {
      tree.root.set('el:t1', el('t1', { type: 'text', text: 'Second', originalText: 'Second' }))
      tree.root.set('z:t1', 2)
      tree.root.set('el:t2', el('t2', { type: 'text', text: 'Premier' }))
      tree.root.set('z:t2', 1)
      tree.root.set('el:r1', el('r1', { type: 'rectangle' }))
      tree.root.set('el:t3', el('t3', { type: 'text', text: 'Efface', isDeleted: true }))
    })
    expect(recordText(extractNote(noteInputFromUpdates('e', 'Schema.excalidraw', log)!))).toBe('Premier\nSecond')
  })

  it('.mindmap : les sujets en liste imbriquee, ecrits par plugin-mindmap', () => {
    const { doc, log } = journaled()
    const data = {
      nodeData: {
        id: 'root', topic: 'Vacances',
        children: [
          { id: 'b', topic: 'Budget', children: [{ id: 'b1', topic: 'Billets' }] },
          { id: 'a', topic: 'Activites #ete' },
        ],
      },
      arrows: [{ id: 'f1', label: 'depend de', from: 'a', to: 'b' }],
    } as unknown as Parameters<typeof writeAll>[1]
    writeAll(new YjsSharedTree(doc), data)
    const r = extractNote(noteInputFromUpdates('m', 'Carte.mindmap', log)!)
    expect(recordText(r)).toBe('Vacances\nBudget\nBillets\nActivites #ete\ndepend de')
    expect(r.tags).toEqual(['ete'])
  })

  it('autres types : rien a indexer', () => {
    const { doc, log } = journaled()
    doc.getText('codemirror').insert(0, 'du texte')
    expect(noteInputFromUpdates('x', 'Discussion.chat', log)).toBeNull()
    expect(withDoc(log, d => readDocContent('image.png', d))).toBeNull()
  })
})
