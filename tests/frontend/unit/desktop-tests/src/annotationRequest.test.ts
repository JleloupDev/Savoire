// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Demander a un agent depuis la note : le brouillon d'un commentaire offre
// « Demander à… » et comprend « @Nom » ; la carte du fil dit ou en est la
// demande et permet de la relancer.
import { describe, it, expect } from 'vitest'
import type { ReviewEntry, ReviewService, ReviewThread } from '@savoire/application'
import { renderAnnotationCard, renderDraftCard, type AnnotationCardDeps, type DraftAsk, type DraftAskDeps } from '../../../../../apps/web/src/AnnotationCard'

const alice = { kind: 'user' as const, userId: 'alice', displayName: 'Alice' }
const AGENTS = [{ id: 'a1', name: 'Relecteur' }, { id: 'a2', name: 'Archiviste' }]

/** La meme regle que l'appli, en plus court : le choix, sinon « @Nom ». */
function askDeps(inApp: boolean, agents = AGENTS): DraftAskDeps {
  return {
    agents: () => agents,
    inApp: () => inApp,
    resolve: (text, choice) => {
      const m = /^(app|external):(.+)$/.exec(choice)
      const agent = m ? agents.find(a => a.id === m[2]) : agents.find(a => text.toLowerCase().includes(`@${a.name.toLowerCase()}`))
      return agent ? { agent, via: m?.[1] === 'external' || !inApp ? 'external' : 'app' } : null
    },
  }
}

function draft(ask?: DraftAskDeps, kind: 'comment' | 'suggestion' = 'comment') {
  const container = document.createElement('div')
  const sent: { text: string; ask: DraftAsk | null }[] = []
  let closed = 0
  renderDraftCard(container, { kind, quote: 'le passage' }, (text, _replacement, to) => { sent.push({ text, ask: to }) }, () => { closed++ }, ask)
  const q = <T extends HTMLElement>(id: string) => container.querySelector<T>(`[data-testid="${id}"]`)
  const type = (value: string) => { const t = q<HTMLTextAreaElement>('annotation-draft-input')!; t.value = value; t.dispatchEvent(new Event('input')) }
  const choose = (value: string) => { const s = q<HTMLSelectElement>('annotation-draft-ask')!; s.value = value; s.dispatchEvent(new Event('change')) }
  return { container, sent, closed: () => closed, q, type, choose }
}

describe('brouillon : demander a un agent', () => {
  it('sans agents, la carte est celle d avant : un simple commentaire', () => {
    const none = draft()
    expect(none.q('annotation-draft-ask')).toBeNull()
    none.type('À revoir')
    none.q('annotation-draft-submit')!.click()
    expect(none.sent).toEqual([{ text: 'À revoir', ask: null }])
    const empty = draft(askDeps(true, []))
    expect(empty.q('annotation-draft-ask')).toBeNull()
  })

  it('« Demander à… » liste les agents : dans Savoire si une IA y est configuree, et par leur IA externe', () => {
    const d = draft(askDeps(true))
    const select = d.q<HTMLSelectElement>('annotation-draft-ask')!
    expect(Array.from(select.querySelectorAll('optgroup')).map(g => g.label)).toEqual(['Dans Savoire, tout de suite', 'Par son IA externe (ChatGPT, Claude…)'])
    expect(Array.from(select.options).map(o => o.value)).toEqual(['', 'app:a1', 'app:a2', 'external:a1', 'external:a2'])
    expect(select.value).toBe('')
    // Sans IA dans l'appli : seulement par l'IA externe.
    const ext = draft(askDeps(false))
    expect(Array.from(ext.q<HTMLSelectElement>('annotation-draft-ask')!.options).map(o => o.value)).toEqual(['', 'external:a1', 'external:a2'])
  })

  it('choisir un agent en fait une demande : le bouton et la phrase le disent avant l envoi', () => {
    const d = draft(askDeps(true))
    d.type('Reformule plus court')
    expect(d.q('annotation-draft-submit')!.textContent).toBe('Commenter')
    expect(d.q('annotation-draft-ask-hint')!.textContent).toBe('')
    d.choose('app:a1')
    expect(d.q('annotation-draft-submit')!.textContent).toBe('Demander')
    expect(d.q('annotation-draft-ask-hint')!.textContent).toBe('Relecteur répondra dans ce fil, et n’écrira que dans ce passage.')
    d.q('annotation-draft-submit')!.click()
    expect(d.sent).toEqual([{ text: 'Reformule plus court', ask: { agent: AGENTS[0], via: 'app' } }])
    expect(d.closed()).toBe(1)
  })

  it('« @Nom » dans le texte suffit ; revenir a un texte sans mention redonne un commentaire', () => {
    const d = draft(askDeps(true))
    d.type('@Archiviste où ranger ça ?')
    expect(d.q('annotation-draft-submit')!.textContent).toBe('Demander')
    expect(d.q('annotation-draft-ask-hint')!.textContent).toContain('Archiviste répondra dans ce fil')
    d.type('où ranger ça ?')
    expect(d.q('annotation-draft-submit')!.textContent).toBe('Commenter')
    d.type('@archiviste où ranger ça ?')
    d.q('annotation-draft-submit')!.click()
    expect(d.sent[0]!.ask).toEqual({ agent: AGENTS[1], via: 'app' })
  })

  it('par son IA externe : la demande attend, et la carte le dit', () => {
    const d = draft(askDeps(true))
    d.type('Vérifie ce chiffre')
    d.choose('external:a2')
    expect(d.q('annotation-draft-ask-hint')!.textContent).toBe('Archiviste verra cette demande par son IA externe, et répondra dans ce fil.')
    d.q('annotation-draft-submit')!.click()
    expect(d.sent[0]!.ask).toEqual({ agent: AGENTS[1], via: 'external' })
  })

  it('une suggestion ne se demande pas a un agent', () => {
    const d = draft(askDeps(true), 'suggestion')
    expect(d.q('annotation-draft-ask')).toBeNull()
    d.q('annotation-draft-submit')!.click()
    expect(d.sent[0]!.ask).toBeNull()
  })
})

function card(root: Partial<ReviewEntry>, opts: { canRetry?: boolean; canWrite?: boolean; withRequests?: boolean } = {}) {
  const entry: ReviewEntry = { id: 't1', docId: 'd1', kind: 'comment', text: '@Relecteur reformule', author: alice, createdAt: '2026-11-25T10:00:00Z', status: 'open', ...root }
  const thread: ReviewThread = { root: entry, replies: [] }
  const listeners = new Set<() => void>()
  const review = {
    thread: (id: string) => (id === 't1' ? thread : undefined),
    onChange: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb) } },
  } as unknown as ReviewService
  const calls: string[] = []
  const deps: AnnotationCardDeps = {
    review, canWrite: () => opts.canWrite ?? true, describeProposal: () => '',
    accept: async () => {}, reject: () => {}, reply: (r, text) => { calls.push(`reply ${r.id} ${text}`) }, resolve: () => {},
    ...(opts.withRequests === false ? {} : {
      requests: {
        line: r => `Demande à ${r.request!.agentName} : ${r.request!.state}`,
        canRetry: () => !!opts.canRetry,
        retry: r => { calls.push(`retry ${r.id}`) },
      },
    }),
  }
  const container = document.createElement('div')
  document.body.append(container)
  renderAnnotationCard(container, ['t1'], deps)
  const q = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  return { q, calls, thread, changed: () => { for (const cb of listeners) cb() } }
}

const request = (state: 'open' | 'running' | 'done' | 'failed') => ({ agentId: 'a1', agentName: 'Relecteur', via: 'app' as const, state, askedAt: '2026-11-25T10:00:00Z' })

describe('carte du fil : ou en est la demande', () => {
  it('un fil sans demande ne montre rien de plus', () => {
    const { q } = card({})
    expect(q('annotation-request')).toBeNull()
    expect((q('annotation-reply-input') as HTMLInputElement).placeholder).toContain('@Nom')
  })

  it('une demande en cours le dit, sans bouton ; elle suit les changements de la revision', () => {
    const c = card({ request: request('running') })
    expect(c.q('annotation-request')!.dataset.state).toBe('running')
    expect(c.q('annotation-request')!.textContent).toContain('Demande à Relecteur : running')
    expect(c.q('annotation-request-retry')).toBeNull()
    // L'agent a repondu : la carte se redessine.
    c.thread.root = { ...c.thread.root, request: request('done') }
    c.thread.replies = [{ id: 'r1', docId: 'd1', kind: 'comment', text: 'Reformulé.', parentId: 't1', createdAt: '2026-11-25T10:00:05Z', author: { kind: 'agent', agentId: 'a1', agentName: 'Relecteur', onBehalfOf: { userId: 'alice', displayName: 'Alice' } } }]
    c.changed()
    expect(c.q('annotation-request')!.dataset.state).toBe('done')
    expect(c.q('annotation-reply')!.textContent).toContain('Reformulé.')
    expect(c.q('annotation-reply')!.textContent).toContain('IA')
  })

  it('une demande echouee se relance d un clic ; pas en lecture seule', () => {
    const c = card({ request: request('failed') }, { canRetry: true })
    c.q('annotation-request-retry')!.click()
    expect(c.calls).toEqual(['retry t1'])
    const ro = card({ request: request('failed') }, { canRetry: true, canWrite: false })
    expect(ro.q('annotation-request')).not.toBeNull()
    expect(ro.q('annotation-request-retry')).toBeNull()
  })

  it('sans la partie « demandes » (editeurs des plugins), la carte reste celle d avant', () => {
    const c = card({ request: request('running') }, { withRequests: false })
    expect(c.q('annotation-request')).toBeNull()
    expect((c.q('annotation-reply-input') as HTMLInputElement).placeholder).toBe('Répondre…')
  })
})
