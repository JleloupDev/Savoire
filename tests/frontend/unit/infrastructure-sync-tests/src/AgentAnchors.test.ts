// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ancres et effet de frappe des agents (ADR-033), sur le vrai texte partage
// de l'appli (YjsCrdtAdapter) :
//  - une ancre (position relative Yjs en base64) se lit de la meme facon dans
//    l'appli (ICollaborativeText) et sur le pair (indexer-core) ;
//  - un long texte se deroule morceau par morceau au bon endroit, meme si
//    quelqu'un ecrit ailleurs entre deux morceaux.
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { YjsCrdtAdapter, relPosFromBase64, relPosToBase64 } from '@savoire/infrastructure-sync'
import { relativeRange, resolveRelativeIn } from '../../../../../packages/indexer-core/src/crdt/write'
import { planTyping, typeInto } from '../../../../../packages/agent-core/src/typing'

function note(initial: string) {
  const crdt = new YjsCrdtAdapter()
  const shared = crdt.sharedText()
  shared.insert(0, initial)
  return { crdt, shared, collab: crdt.collaborativeText(), doc: crdt.rawDoc as Y.Doc }
}

describe('ancres des agents : meme format dans l appli et sur le pair', () => {
  it('une position de l appli, en base64, se resout sur le pair, et suit les modifications', () => {
    const n = note('Un chat dort. Un chat mange.')
    const start = relPosToBase64(n.collab.createRelPos(17, 0))
    const end = relPosToBase64(n.collab.createRelPos(21, -1))
    // C'est bien Y.encodeRelativePosition, puis base64.
    expect(Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(Buffer.from(start, 'base64')), n.doc)!.index).toBe(17)
    n.shared.insert(0, 'Avant. ')
    expect(resolveRelativeIn(n.doc, start, end)).toEqual({ from: 24, to: 28 })
    expect(n.collab.resolveRelPos(relPosFromBase64(start)!)).toBe(24)
  })

  it('une position du pair se resout dans l appli ; un curseur : debut = fin', () => {
    const n = note('Un chat dort.')
    const sel = relativeRange(n.doc, 3, 7)
    const cursor = relativeRange(n.doc, 13, 13)
    expect(cursor.end).toBe(cursor.start)
    n.shared.insert(0, '>> ')
    expect([n.collab.resolveRelPos(relPosFromBase64(sel.start)!), n.collab.resolveRelPos(relPosFromBase64(sel.end)!)]).toEqual([6, 10])
    expect(resolveRelativeIn(n.doc, cursor.start, cursor.end)).toEqual({ from: 16, to: 16 })
  })

  it('une position illisible, ou d un autre document, ne se resout pas', () => {
    const n = note('texte')
    expect(relPosFromBase64('pas du base64 !')).toBeNull()
    expect(resolveRelativeIn(n.doc, 'pas du base64 !', 'pas du base64 !')).toBeNull()
    const other = note('un tout autre document, plus long')
    const far = relativeRange(other.doc, 20, 25)
    expect(resolveRelativeIn(n.doc, far.start, far.end)).toBeNull()
  })
})

describe('effet de frappe dans le texte partage', () => {
  const long = 'Voici un long paragraphe écrit par une IA, que les personnes qui ont la note ouverte doivent voir arriver petit à petit, mot après mot.'

  it('plusieurs changements en une modification, puis la suite morceau par morceau', async () => {
    const n = note('AAAA BBBB CCCC')
    const steps: string[] = []
    n.shared.onChange(() => steps.push(n.shared.toString()))
    const plan = planTyping([{ from: 0, to: 4, text: 'aa' }, { from: 5, to: 5, text: long }, { from: 10, to: 14, text: 'cc' }], { budgetMs: 100, maxWrites: 6 })
    await typeInto({ applyDelta: d => n.shared.applyDelta(d), createRelPos: (i, a) => n.collab.createRelPos(i, a), resolveRelPos: rp => n.collab.resolveRelPos(rp) }, plan, async () => {})
    expect(n.shared.toString()).toBe(`aa ${long}BBBB cc`)
    // La premiere modification fait tout le reste d'un coup ; ensuite le texte s'allonge.
    expect(steps[0]!.startsWith('aa Voici')).toBe(true)
    expect(steps[0]!.endsWith('BBBB cc')).toBe(true)
    expect(steps.length).toBe(1 + plan.tails[0]!.chunks.length)
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.length).toBeGreaterThan(steps[i - 1]!.length)
  })

  it('quelqu un ecrit avant, et juste apres, pendant la frappe : la suite arrive a sa place', async () => {
    const n = note('Début. Fin.')
    const plan = planTyping([{ from: 7, to: 7, text: `${long} ` }], { budgetMs: 100, maxWrites: 8 })
    let pause = 0
    await typeInto({ applyDelta: d => n.shared.applyDelta(d), createRelPos: (i, a) => n.collab.createRelPos(i, a), resolveRelPos: rp => n.collab.resolveRelPos(rp) }, plan, async () => {
      pause++
      if (pause === 1) n.shared.insert(0, 'Jean : ')
      if (pause === 2) n.shared.insert(n.shared.toString().indexOf('Fin.'), 'Presque la ')
    })
    expect(n.shared.toString()).toBe(`Jean : Début. ${long} Presque la Fin.`)
  })
})
