// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Revision ancree : un passage suit les modifications, une suggestion
// s'accepte (la note change) ou se refuse ; refusee si le passage a change.
import { describe, it, expect, afterEach } from 'vitest'
import { ReviewConflictError, ReviewService, type IVaultSyncSession, type ReviewText, type UserActor } from '@savoire/application'
import { InProcessPeerBus, LocalPeerVaultSessionFactory, YjsCrdtAdapter } from '@savoire/infrastructure-sync'

const alice: UserActor = { kind: 'user', userId: 'alice', displayName: 'Alice' }

/** Le texte d'une note, comme l'app le donne a la revision. */
function noteText(initial: string): { text: ReviewText; edit(i: number, del: number, ins: string): void } {
  const crdt = new YjsCrdtAdapter()
  const shared = crdt.sharedText()
  shared.insert(0, initial)
  const collab = crdt.collaborativeText()
  const text: ReviewText = {
    toString: () => collab.toString(),
    get length() { return collab.length },
    createRelPos: (i, a) => collab.createRelPos(i, a),
    resolveRelPos: rp => collab.resolveRelPos(rp),
    slice: (a, b) => collab.slice(a, b),
    replace: (from, to, ins) => shared.applyDelta([{ retain: from }, { delete: to - from }, ...(ins ? [{ insert: ins }] : [])]),
  }
  return { text, edit: (i, del, ins) => { if (del) shared.delete(i, del); if (ins) shared.insert(i, ins) } }
}

describe('ReviewService : ancres et suggestions', () => {
  const sessions: IVaultSyncSession[] = []
  afterEach(async () => { for (const s of sessions.splice(0)) await s.dispose() })
  async function service() {
    const factory = new LocalPeerVaultSessionFactory(new InProcessPeerBus(), { settleMs: 5 })
    const s = await factory.open({ vaultId: 'v1', token: '', userId: 'alice', onChanged: () => {} })
    sessions.push(s)
    return new ReviewService(s)
  }

  it('le passage ancre suit les modifications faites avant et autour', () => {
    const note = noteText('Le chat dort sur le tapis.')
    const anchor = ReviewService.anchor(note.text, 3, 7)
    expect(anchor.quote).toBe('chat')
    note.edit(0, 0, 'Ce matin, ')
    note.edit(note.text.length - 1, 0, ' rouge')
    const at = ReviewService.locate(anchor, note.text)!
    expect(at.current).toBe('chat')
    // Un ajout juste apres le passage n'y entre pas.
    note.edit(at.to, 0, 'on')
    expect(ReviewService.locate(anchor, note.text)!.current).toBe('chat')
    // Passage supprime : introuvable.
    const again = ReviewService.locate(anchor, note.text)!
    note.edit(again.from, 4, '')
    expect(ReviewService.locate(anchor, note.text)).toBeNull()
  })

  it('une suggestion acceptee remplace le passage, une seule fois', async () => {
    const review = await service()
    const note = noteText('Bilan du trimestre : bon.')
    const s = review.suggest('d1', ReviewService.anchor(note.text, 21, 24), 'excellent', alice, 'Plus fort')
    expect(review.threads('d1')[0].root).toMatchObject({ kind: 'suggestion', status: 'open', replacement: 'excellent', text: 'Plus fort' })
    note.edit(0, 0, '# ')
    review.accept(s.id, note.text, alice)
    expect(note.text.toString()).toBe('# Bilan du trimestre : excellent.')
    expect(review.threads('d1')[0].root.status).toBe('accepted')
    expect(() => review.accept(s.id, note.text, alice)).toThrow()
  })

  it('refusee si le passage a change ; un refus ne touche pas la note', async () => {
    const review = await service()
    const note = noteText('Un deux trois')
    const s = review.suggest('d1', ReviewService.anchor(note.text, 3, 7), '', alice)
    note.edit(4, 1, 'E')
    expect(() => review.accept(s.id, note.text, alice)).toThrow(ReviewConflictError)
    review.setStatus(s.id, 'rejected', alice)
    expect(note.text.toString()).toBe('Un dEux trois')
    expect(review.threads('d1')[0].root.status).toBe('rejected')
    expect(() => review.setStatus(s.id, 'accepted', alice)).toThrow()
  })

  it('un commentaire peut viser un passage ; une suggestion qui ne change rien est refusee', async () => {
    const review = await service()
    const note = noteText('abc def')
    const c = review.comment('d1', 'Pourquoi ?', alice, ReviewService.anchor(note.text, 4, 7))
    expect(c.anchor?.quote).toBe('def')
    expect(() => review.suggest('d1', ReviewService.anchor(note.text, 0, 3), 'abc', alice)).toThrow()
  })
})
