// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un agent de l'appli se montre dans la note qu'il lit ou ecrit (ADR-033) :
// l'hote pose sa presence sur le document ouvert, la retire peu apres son
// dernier geste, et rend le document. Sans agent declare : rien.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../../../apps/web/src/reviewProposals', () => ({ reviewFor: () => ({}) }))

import { AppToolHost, PRESENCE_IDLE_MS, PRESENCE_LINGER_MS } from '../../../../../apps/web/src/agents/appToolHost'
import { agentColor } from '@savoire/agent-core'
import type { AgentPresenceInput } from '@savoire/plugin-api'

/** Une session qui compte ses ouvertures, avec un CRDT qui note les presences. */
function fakeSession(withPresence = true) {
  const open = new Map<string, number>()
  const shown: (AgentPresenceInput & { docId: string })[] = []
  const session = {
    openDocument(docId: string) {
      open.set(docId, (open.get(docId) ?? 0) + 1)
      return withPresence ? { setAgentPresence: (p: AgentPresenceInput) => { shown.push({ docId, ...p }) } } : {}
    },
    closeDocument(docId: string) { open.set(docId, (open.get(docId) ?? 0) - 1) },
  }
  return { session, open, shown }
}

const host = (s: ReturnType<typeof fakeSession>) => new AppToolHost({ client: {} as never, session: s.session as never, api: null })
const agent = { id: 'a1', name: 'Correcteur' }
const shownAs = { id: 'a1', name: 'Correcteur', color: agentColor(agent), onBehalfOf: 'Jean' }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('presence d un agent de l appli', () => {
  it('sans agent declare, l hote ne montre rien', () => {
    const s = fakeSession()
    host(s).signal({ docId: 'd1', state: 'writing', from: 0, to: 3 })
    expect(s.shown).toEqual([])
    expect(s.open.size).toBe(0)
  })

  it('il se montre, puis part peu apres son dernier geste, et rend le document', () => {
    const s = fakeSession()
    const h = host(s).withPresence(agent, 'Jean')
    h.signal({ docId: 'd1', state: 'reading', from: 0, to: 20 })
    expect(s.shown).toEqual([{ docId: 'd1', agent: shownAs, activity: { state: 'reading', from: 0, to: 20 } }])
    expect(s.open.get('d1')).toBe(1)

    // Un nouveau geste avant la fin : le meme document, le delai repart.
    vi.advanceTimersByTime(PRESENCE_LINGER_MS - 500)
    h.signal({ docId: 'd1', state: 'writing', from: 5, to: 9 })
    expect(s.open.get('d1')).toBe(1)
    vi.advanceTimersByTime(PRESENCE_LINGER_MS - 500)
    expect(s.shown.at(-1)).toMatchObject({ activity: { state: 'writing', from: 5, to: 9 } })

    vi.advanceTimersByTime(600)
    expect(s.shown.at(-1)).toEqual({ docId: 'd1', agent: shownAs, activity: null })
    expect(s.open.get('d1')).toBe(0)
  })

  it('« fini » le fait partir plus vite ; sans presence en cours, rien', () => {
    const s = fakeSession()
    const h = host(s).withPresence({ ...agent, color: '#0A7FC2' })
    h.signal({ docId: 'd1', state: 'idle' })
    expect(s.shown).toEqual([])
    h.signal({ docId: 'd1', state: 'writing' })
    expect(s.shown[0]).toEqual({ docId: 'd1', agent: { id: 'a1', name: 'Correcteur', color: '#0a7fc2' }, activity: { state: 'writing' } })
    h.signal({ docId: 'd1', state: 'idle' })
    vi.advanceTimersByTime(PRESENCE_IDLE_MS + 10)
    expect(s.shown.at(-1)!.activity).toBeNull()
    expect(s.open.get('d1')).toBe(0)
  })

  it('un document sans presence (dessin, base) : rendu tout de suite, rien ne casse', () => {
    const s = fakeSession(false)
    const h = host(s).withPresence(agent)
    expect(() => h.signal({ docId: 'd1', state: 'writing', from: 0, to: 1 })).not.toThrow()
    expect(s.open.get('d1')).toBe(0)
    vi.advanceTimersByTime(PRESENCE_LINGER_MS * 2)
    expect(s.open.get('d1')).toBe(0)
  })
})
