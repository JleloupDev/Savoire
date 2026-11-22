// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Carte de revision posee sur la note : on y accepte, refuse, resout et
// repond sans ouvrir le panneau ; ce qu'on tape survit aux mises a jour.
import { describe, it, expect } from 'vitest'
import type { ReviewEntry, ReviewService, ReviewThread } from '@savoire/application'
import { renderAnnotationCard, renderDraftCard, type AnnotationCardDeps } from '../../../../../apps/web/src/AnnotationCard'

const alice = { kind: 'user' as const, userId: 'alice', displayName: 'Alice' }

function fakeReview(threads: ReviewThread[]) {
  const listeners = new Set<() => void>()
  const review = {
    thread: (id: string) => threads.find(t => t.root.id === id),
    onChange: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  } as unknown as ReviewService
  return { review, changed: () => { for (const cb of listeners) cb() } }
}

function setup(root: Partial<ReviewEntry>, canWrite = true, acceptFails = false) {
  const entry: ReviewEntry = { id: 't1', docId: 'd1', kind: 'comment', text: 'A revoir', author: alice, createdAt: '2026-11-22T10:00:00Z', status: 'open', ...root }
  const thread: ReviewThread = { root: entry, replies: [] }
  const { review, changed } = fakeReview([thread])
  const notify = () => changed()
  const calls: string[] = []
  const deps: AnnotationCardDeps = {
    review,
    canWrite: () => canWrite,
    describeProposal: () => 'Statut : En cours → Fait',
    accept: async r => { if (acceptFails) throw new Error('Le passage a changé depuis la suggestion.'); calls.push(`accept ${r.id}`) },
    reject: r => { calls.push(`reject ${r.id}`) },
    // La vraie revision previent tout de suite : la carte se redessine pendant l'envoi.
    reply: (r, text) => { calls.push(`reply ${r.id} ${text}`); notify() },
    resolve: (r, on) => { calls.push(`resolve ${r.id} ${on}`) },
  }
  const container = document.createElement('div')
  document.body.append(container)
  let done = 0
  const stop = renderAnnotationCard(container, ['t1'], deps, () => { done++ })
  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  return { container, calls, done: () => done, stop, q, thread, changed }
}

describe('carte d\'annotation', () => {
  it('une suggestion s\'accepte ou se refuse dans la carte, puis la carte se ferme', async () => {
    const { q, calls, done } = setup({ kind: 'suggestion', text: 'Suggestion', anchor: { from: {} as never, to: {} as never, quote: 'vieux' }, replacement: 'neuf' })
    expect(q('annotation-thread')?.textContent).toContain('vieux')
    expect(q('annotation-thread')?.textContent).toContain('neuf')
    q('annotation-accept')!.click()
    await Promise.resolve(); await Promise.resolve()
    expect(calls).toEqual(['accept t1'])
    expect(done()).toBe(1)
    q('annotation-reject')!.click()
    expect(calls).toEqual(['accept t1', 'reject t1'])
  })

  it('un commentaire se resout ; ses boutons de suggestion n\'y sont pas', () => {
    const { q, calls } = setup({})
    expect(q('annotation-accept')).toBeNull()
    q('annotation-resolve')!.click()
    expect(calls).toEqual(['resolve t1 true'])
  })

  it('une proposition de plugin est decrite par son type', () => {
    const { q } = setup({ kind: 'proposal', text: 'Proposition', proposalType: 'base.cell', payload: {} })
    expect(q('annotation-thread')?.textContent).toContain('Statut : En cours → Fait')
  })

  it('repondre ; le texte en cours survit a une mise a jour de la revision', () => {
    const { q, calls, changed } = setup({})
    const input = q('annotation-reply-input') as HTMLInputElement
    input.value = 'Je m’en'
    input.dispatchEvent(new Event('input'))
    changed()
    const again = q('annotation-reply-input') as HTMLInputElement
    expect(again.value).toBe('Je m’en')
    again.value = 'Je m’en occupe'
    again.dispatchEvent(new Event('input'))
    q('annotation-reply-submit')!.click()
    expect(calls).toEqual(['reply t1 Je m’en occupe'])
    expect((q('annotation-reply-input') as HTMLInputElement).value).toBe('')
  })

  it('une erreur de decision s\'affiche dans la carte, qui reste ouverte', async () => {
    const { q, done } = setup({ kind: 'suggestion', anchor: { from: {} as never, to: {} as never, quote: 'a' }, replacement: 'b' }, true, true)
    q('annotation-accept')!.click()
    await new Promise(r => setTimeout(r, 0))
    expect(q('annotation-error')?.textContent).toBe('Le passage a changé depuis la suggestion.')
    expect(done()).toBe(0)
  })

  it('retirer la carte la vide', () => {
    const { stop, container } = setup({})
    stop()
    expect(container.children).toHaveLength(0)
  })

  it('en lecture seule, ni decision ni reponse', () => {
    const { q } = setup({ kind: 'suggestion', anchor: { from: {} as never, to: {} as never, quote: 'a' }, replacement: 'b' }, false)
    expect(q('annotation-accept')).toBeNull()
    expect(q('annotation-reply-input')).toBeNull()
  })
})

describe('brouillon dans la note', () => {
  it('suggerer : le texte propose part de la citation, puis la carte se ferme', () => {
    const container = document.createElement('div')
    const sent: [string, string][] = []
    let closed = 0
    renderDraftCard(container, { kind: 'suggestion', quote: 'vieux' }, (text, replacement) => { sent.push([text, replacement]) }, () => { closed++ })
    const replacement = container.querySelector<HTMLTextAreaElement>('[data-testid="annotation-draft-replacement"]')!
    expect(replacement.value).toBe('vieux')
    replacement.value = 'neuf'
    container.querySelector<HTMLElement>('[data-testid="annotation-draft-submit"]')!.click()
    expect(sent).toEqual([['', 'neuf']])
    expect(closed).toBe(1)
  })

  it('une erreur s\'affiche et la carte reste ouverte', () => {
    const container = document.createElement('div')
    let closed = 0
    renderDraftCard(container, { kind: 'comment', quote: 'x' }, () => { throw new Error('commentaire vide') }, () => { closed++ })
    container.querySelector<HTMLElement>('[data-testid="annotation-draft-submit"]')!.click()
    expect(container.querySelector('[data-testid="annotation-error"]')?.textContent).toBe('commentaire vide')
    expect(closed).toBe(0)
  })
})
