// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'ancre d'un passage donnee a l'IA (contexte de l'editeur, epingles,
// surlignages) : des positions relatives Yjs en base64, sur le vrai texte
// de la note. Elle suit les modifications ; un autre pair la relit.
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { YjsCrdtAdapter, base64ToBytes, decodeRelPos, encodeRelPos } from '@savoire/infrastructure-sync'
import type { ICollaborativeText } from '@savoire/domain-index'
import { buildAnchor, buildEditorContext, type EditorAnchor } from '../../../../../packages/agent-core/src/editorContext'

function note(initial: string) {
  const crdt = new YjsCrdtAdapter()
  const shared = crdt.sharedText()
  shared.insert(0, initial)
  const text = crdt.collaborativeText()
  return { crdt, text, edit: (i: number, del: number, ins: string) => { if (del) shared.delete(i, del); if (ins) shared.insert(i, ins) } }
}

const anchorOf = (text: ICollaborativeText, from: number, to: number): EditorAnchor =>
  buildAnchor({ docId: 'd', text: text.toString(), from, to, encode: (i, assoc) => encodeRelPos(text.createRelPos(i, assoc)) })

function locate(text: ICollaborativeText, a: EditorAnchor): { from: number; to: number } | null {
  const from = text.resolveRelPos(decodeRelPos(a.start)!)
  const to = text.resolveRelPos(decodeRelPos(a.end)!)
  return from === null || to === null ? null : { from, to }
}

describe('ancre d un passage pour l IA', () => {
  it('le codage est celui de Yjs (Y.encodeRelativePosition, en base64), aller et retour', () => {
    const n = note('Le chat dort sur le tapis.')
    const a = anchorOf(n.text, 3, 7)
    expect(a).toMatchObject({ docId: 'd', quote: 'chat', prefix: 'Le ', suffix: ' dort sur le tapis.' })
    expect(a.start).toMatch(/^[A-Za-z0-9+/]+=*$/)
    // Yjs relit ces octets tels quels : c'est ce que fera le pair, cote ecriture.
    const ydoc = (n.crdt as unknown as { ydoc: Y.Doc }).ydoc
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(base64ToBytes(a.start)), ydoc)
    expect(abs?.index).toBe(3)
    expect(Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(base64ToBytes(a.end)), ydoc)?.index).toBe(7)
    expect(decodeRelPos('pas une position')).toBeNull()
  })

  it('le passage suit ce qu on ecrit avant, apres et autour ; ce qu on ajoute a ses bords n y entre pas', () => {
    const n = note('Le chat dort sur le tapis.')
    const a = anchorOf(n.text, 3, 7)
    n.edit(0, 0, 'Ce matin, ')
    n.edit(n.text.length - 1, 0, ' rouge')
    let at = locate(n.text, a)!
    expect(n.text.slice(at.from, at.to)).toBe('chat')
    // Juste avant et juste apres le passage.
    n.edit(at.from, 0, 'gros ')
    at = locate(n.text, a)!
    n.edit(at.to, 0, ' noir')
    at = locate(n.text, a)!
    expect(n.text.slice(at.from, at.to)).toBe('chat')
    // Dans le passage : il s'etend.
    n.edit(at.from + 2, 0, 'aaa')
    at = locate(n.text, a)!
    expect(n.text.slice(at.from, at.to)).toBe('chaaaat')
  })

  it('un curseur : fin = debut, et il reste a sa place', () => {
    const n = note('Un. Deux. Trois.')
    const a = anchorOf(n.text, 4, 4)
    expect(a.end).toBe(a.start)
    expect(a.quote).toBe('')
    expect(a).toMatchObject({ prefix: 'Un. ', suffix: 'Deux. Trois.' })
    n.edit(0, 0, 'Zéro. ')
    expect(locate(n.text, a)).toEqual({ from: 10, to: 10 })
    expect(n.text.slice(10, 14)).toBe('Deux')
  })

  it('un autre pair, synchronise, retrouve le meme passage', () => {
    const n = note('Alpha beta gamma.')
    const a = anchorOf(n.text, 6, 10)
    const ydoc = (n.crdt as unknown as { ydoc: Y.Doc }).ydoc
    const peer = new Y.Doc()
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(ydoc))
    peer.getText('codemirror').insert(0, 'Avant. ')
    const start = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(base64ToBytes(a.start)), peer)!.index
    const end = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(base64ToBytes(a.end)), peer)!.index
    expect(peer.getText('codemirror').toString().slice(start, end)).toBe('beta')
  })

  it('l entree de contexte porte cette ancre', () => {
    const n = note('# Titre\n\nUn paragraphe a reformuler, ici.')
    const text = n.text.toString()
    const from = text.indexOf('a reformuler')
    const e = buildEditorContext({
      vaultId: 'v', docId: 'd', path: 'a.md', text, from, to: from + 12, tabId: 't', at: 5,
      encode: (i, assoc) => encodeRelPos(n.text.createRelPos(i, assoc)),
    })
    expect(e.headingPath).toEqual(['Titre'])
    const at = locate(n.text, e.anchor)!
    expect(text.slice(at.from, at.to)).toBe('a reformuler')
    expect(e.anchor.quote).toBe(e.selection)
  })
})
