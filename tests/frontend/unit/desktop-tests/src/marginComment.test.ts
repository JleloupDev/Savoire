// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La carte courte d'un fil dans la marge : auteur, debut du texte, reponses.
// Une suggestion sans explication dit ce qu'elle change.
import { describe, it, expect } from 'vitest'
import type { Actor, ReviewEntry, ReviewThread } from '@savoire/application'
import { marginCommentOf } from '../../../../../apps/web/src/AnnotationCard'

const alice = { kind: 'user' as const, userId: 'alice', displayName: 'Alice' }
const anchor = (quote: string) => ({ from: {} as never, to: {} as never, quote })

function thread(root: Partial<ReviewEntry>, replies = 0): ReviewThread {
  const entry: ReviewEntry = { id: 't1', docId: 'd1', kind: 'comment', text: 'A revoir', author: alice, createdAt: '2026-11-25T10:00:00Z', status: 'open', ...root }
  return { root: entry, replies: Array.from({ length: replies }, (_, i) => ({ ...entry, id: `r${i}`, text: 'ok' })) }
}

describe('carte courte d\'un fil dans la marge', () => {
  it('un commentaire : son auteur, son texte, ses reponses', () => {
    expect(marginCommentOf(thread({ anchor: anchor('le passage') }, 2))).toEqual({ id: 't1', author: 'Alice', text: 'A revoir', replies: 2 })
  })

  it('une suggestion sans explication dit ce qu\'elle change', () => {
    expect(marginCommentOf(thread({ kind: 'suggestion', text: 'Suggestion', anchor: anchor('vieux'), replacement: 'neuf' })))
      .toEqual({ id: 't1', author: 'Alice', text: '« vieux » → « neuf »', replies: 0, label: 'Suggestion' })
    expect(marginCommentOf(thread({ kind: 'suggestion', text: 'Suggestion', anchor: anchor('en trop'), replacement: '' })).text)
      .toBe('Supprimer « en trop »')
  })

  it('une suggestion expliquee garde son explication ; un long passage est coupe', () => {
    expect(marginCommentOf(thread({ kind: 'suggestion', text: 'Plus court', anchor: anchor('vieux'), replacement: 'neuf' })).text).toBe('Plus court')
    const long = marginCommentOf(thread({ kind: 'suggestion', text: 'Suggestion', anchor: anchor('a'.repeat(200)), replacement: 'b' })).text
    expect(long).toBe(`« ${'a'.repeat(60)}… » → « b »`)
  })

  it('un fil ecrit par un agent porte la pastille IA', () => {
    const agent: Actor = { kind: 'agent', agentId: 'a1', agentName: 'Relecteur', onBehalfOf: { userId: 'alice', displayName: 'Alice' } }
    const card = marginCommentOf(thread({ author: agent, anchor: anchor('x') }))
    expect(card.agent).toBe(true)
    expect(card.author).toContain('Relecteur')
  })
})
