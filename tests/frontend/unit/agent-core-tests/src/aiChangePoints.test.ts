// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Chaque ecriture d'un agent devient un point d'historique de la note,
// annulable seul (infrastructure-sync/AiChanges.ts) :
//  - les outils du socle disent a l'hote ce qu'ils font et pourquoi
//    (applyChanges : `what`, `why`) ;
//  - l'hote de l'appli range le point dans le CRDT de la note, avec l'agent
//    et la personne ; seules les modifications de l'agent comptent ; une
//    frappe interrompue en route reste annulable.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../../../apps/web/src/reviewProposals', () => ({ reviewFor: () => ({}) }))

import { AppToolHost } from '../../../../../apps/web/src/agents/appToolHost'
import { YjsCrdtAdapter } from '../../../../../packages/infrastructure-sync/src/YjsCrdtAdapter'
import { ReadMemory, ToolBox, agentColor, refBlocks, type TextChange } from '@savoire/agent-core'
import type { AgentDefinition, ToolActor } from '@savoire/plugin-api'
import { MemoryHost } from './memoryHost'

const actor: ToolActor = { agentId: 'a1', agentName: 'Archiviste', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const JEAN = { id: 'u1', name: 'Jean' }

function agent(p: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'a1', name: 'Archiviste', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct' }, ...p }
}

// ── Les outils du socle : what et why arrivent a l'hote ─────────────────────

type Opts = { typing?: boolean; expect?: string; what?: string; why?: string }

/** Un hote qui note ce que les outils lui disent de chaque ecriture. */
class OptsHost extends MemoryHost {
  seen: Opts[] = []

  async applyChanges(docId: string, changes: readonly TextChange[], _actor: ToolActor, opts: Opts = {}): Promise<void> {
    const n = this.notes.get(docId)!
    let out = ''
    let at = 0
    for (const c of changes) {
      out += n.content.slice(at, c.from) + c.text
      at = c.to
    }
    n.content = out + n.content.slice(at)
    this.seen.push(opts)
  }
}

const box = (host: MemoryHost, runtime: 'app' | 'server' = 'app'): ToolBox =>
  new ToolBox({ agent: agent(), person: { canWrite: true }, actor, runtime, host, memory: new ReadMemory() })

describe('les outils disent a l hote ce qu ils font et pourquoi', () => {
  it('edit_note : « passage remplacé », avec la raison', async () => {
    const host = new OptsHost({ 'Plan.md': 'Un. Deux. Trois.' })
    const r = await box(host).call('edit_note', { path: 'Plan.md', find: 'Deux.', replace: 'Autre.', why: 'plus clair' })
    expect(r.result.isError).toBeFalsy()
    expect(host.seen).toEqual([{ typing: true, what: 'passage remplacé', why: 'plus clair' }])
    // La trace de la Revision ne change pas.
    expect(host.review.filter(e => e.kind === 'edit').map(e => e.text)).toEqual(['passage remplacé : plus clair'])
  })

  it('append sans raison : le resume seul, pas de `why`', async () => {
    const host = new OptsHost({ 'Plan.md': 'Un.' })
    await box(host).call('append', { path: 'Plan.md', text: 'Deux.' })
    expect(host.seen).toEqual([{ typing: true, what: '5 caractères ajoutés à la fin' }])
    expect(host.seen[0]).not.toHaveProperty('why')
  })

  it('patch_note : « 2 retouches », avec la raison et l empreinte attendue', async () => {
    const note = '# Plan\n\nIntroduction.\n\n## Suite\n\nLa suite.'
    const host = new OptsHost({ 'Plan.md': note })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md' })
    const ref = (start: string): string => refBlocks(note).find(b => b.text.startsWith(start))!.ref
    const r = await tb.call('patch_note', {
      path: 'Plan.md',
      ops: [{ op: 'insert_after', ref: ref('Introduction'), text: 'Un ajout.' }, { op: 'insert_after', ref: ref('La suite'), text: 'Fin.' }],
      why: 'compléter',
    })
    expect(r.result.isError).toBeFalsy()
    expect(host.seen).toHaveLength(1)
    expect(host.seen[0]).toMatchObject({ typing: true, what: '2 retouches', why: 'compléter' })
    expect(host.seen[0]!.expect).toBeTruthy()
  })

  it('add_image : « image ajoutée (nom) », avec la raison', async () => {
    const host = new OptsHost({ 'Projets/Plan.md': 'Le plan.' })
    const r = await box(host, 'server').call('add_image', { path: 'Projets/Plan.md', fileId: 'f-1', fileName: 'Tableau.JPG', why: 'illustrer' })
    expect(r.result.isError).toBeFalsy()
    expect(host.seen).toHaveLength(1)
    expect(host.seen[0]!.what).toMatch(/^image ajoutée \(.+\)$/)
    expect(host.seen[0]!.why).toBe('illustrer')
  })
})

// ── L'hote de l'appli : le point dans le CRDT de la note ────────────────────

/** Une session a une note : le vrai adaptateur Yjs de l'appli. */
function oneNote(content: string) {
  const crdt = new YjsCrdtAdapter()
  crdt.sharedText().applyDelta([{ insert: content }])
  let opened = 0
  /** Si pose : ce que la session rend a la place du CRDT (pour le faire echouer). */
  const swap: { crdt?: unknown } = {}
  const session = {
    openDocument() { opened++; return swap.crdt ?? crdt },
    closeDocument() { opened-- },
  }
  const host = new AppToolHost({ client: {} as never, session: session as never, api: null })
  return { crdt, host, swap, text: () => crdt.sharedText().toString(), opened: () => opened }
}

/** Le temps que la frappe finisse et que le document soit rendu (l'awareness de Yjs garde une horloge : pas de runAllTimers). */
const SETTLE_MS = 10_000
/** Un texte assez long pour l'effet de frappe (plusieurs morceaux). */
const LONG = Array.from({ length: 40 }, (_, i) => `mot${i}`).join(' ') + '.'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('l hote de l appli range un point par ecriture d agent', () => {
  it('une ecriture : qui, pour qui, quoi, pourquoi ; annuler remet le texte', async () => {
    const n = oneNote('Un. Deux. Trois.')
    await n.host.applyChanges('d1', [{ from: 4, to: 9, text: 'Autre.' }], actor, { what: 'passage remplacé', why: 'plus clair' })
    expect(n.text()).toBe('Un. Autre. Trois.')
    const points = n.crdt.aiChanges()
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({
      agent: { id: 'a1', name: 'Archiviste', color: agentColor({ id: 'a1' }) },
      forUser: JEAN,
      summaries: ['passage remplacé'], reasons: ['plus clair'],
      count: 1, inserted: 6, deleted: 5,
    })
    expect(n.crdt.undoAiChange(points[0]!.parts, JEAN)).toEqual({ ok: true, partial: false })
    expect(n.text()).toBe('Un. Deux. Trois.')
    expect(n.crdt.aiChanges()[0]!.undone?.by).toEqual(JEAN)
    // Le document est rendu.
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    expect(n.opened()).toBe(0)
  })

  it('la couleur declaree de l agent (withPresence) est celle du point', async () => {
    const n = oneNote('Un.')
    await n.host.withPresence({ id: 'a1', name: 'Archiviste', color: '#0A7FC2' }, 'Jean').applyChanges('d1', [{ from: 3, to: 3, text: ' Deux.' }], actor)
    expect(n.crdt.aiChanges()[0]).toMatchObject({ agent: { color: '#0a7fc2' }, summaries: [], reasons: [] })
  })

  it('effet de frappe : un seul point pour tout le texte ; ce que la personne tape pendant n est pas compte', async () => {
    const n = oneNote('Début. Fin.')
    const shared = n.crdt.sharedText()
    let deltas = 0
    shared.onChange(() => { deltas++ })
    const done = n.host.applyChanges('d1', [{ from: 7, to: 7, text: `${LONG} ` }], actor, { typing: true, what: 'texte ajouté' })
    // La personne tape au debut de la note entre deux morceaux.
    await vi.advanceTimersByTimeAsync(150)
    shared.applyDelta([{ insert: '> ' }])
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    await done
    expect(n.text()).toBe(`> Début. ${LONG} Fin.`)
    expect(deltas).toBeGreaterThan(3)
    const points = n.crdt.aiChanges()
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ count: 1, inserted: LONG.length + 1, deleted: 0, summaries: ['texte ajouté'] })
    expect(n.crdt.aiChangeRanges(points[0]!.parts).inserted).toEqual([{ from: 9, to: 9 + LONG.length + 1 }])
    n.crdt.undoAiChange(points[0]!.parts, JEAN)
    expect(n.text()).toBe('> Début. Fin.')
  })

  it('la frappe echoue en route : ce qui est ecrit a son point, et s annule', async () => {
    const n = oneNote('Début. Fin.')
    const shared = n.crdt.sharedText()
    let calls = 0
    // Le meme CRDT, dont le texte refuse la troisieme ecriture.
    n.swap.crdt = new Proxy(n.crdt, {
      get(target, key) {
        if (key === 'sharedText') {
          return () => new Proxy(shared, {
            get(t, k) {
              if (k === 'applyDelta') return (delta: never) => { if (++calls === 3) throw new Error('coupé'); t.applyDelta(delta) }
              const v = Reflect.get(t, k) as unknown
              return typeof v === 'function' ? v.bind(t) : v
            },
          })
        }
        const v = Reflect.get(target, key) as unknown
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
    const done = n.host.applyChanges('d1', [{ from: 7, to: 7, text: `${LONG} ` }], actor, { typing: true, what: 'texte ajouté', why: 'compléter' })
    const failed = expect(done).rejects.toThrow('coupé')
    await vi.advanceTimersByTimeAsync(SETTLE_MS)
    await failed
    // Deux morceaux sont dans la note, pas la suite.
    expect(n.text()).not.toBe('Début. Fin.')
    expect(n.text()).not.toContain('mot39')
    const points = n.crdt.aiChanges()
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ reasons: ['compléter'], inserted: n.text().length - 'Début. Fin.'.length })
    n.crdt.undoAiChange(points[0]!.parts, JEAN)
    expect(n.text()).toBe('Début. Fin.')
  })

  it('une ecriture refusee (la note a change) ne laisse aucun point', async () => {
    const n = oneNote('Un.')
    await expect(n.host.applyChanges('d1', [{ from: 0, to: 2, text: 'X' }], actor, { expect: 'autre empreinte' })).rejects.toThrow('relisez-la')
    expect(n.crdt.aiChanges()).toEqual([])
    expect(n.text()).toBe('Un.')
  })
})
