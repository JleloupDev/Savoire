// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-board : l'iframe isolee et ce que Savoire accepte d'elle.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { InMemoryQueryEngine } from '@savoire/plugin-runtime'
import type { PluginAPI } from '@savoire/plugin-api'
import { BOARD_CSP, BoardHost, buildSrcdoc, parseBoardEmbed, resetBoardGrants } from '@savoire/plugin-board'

function world(text = '---\nc1: 3\n---\n') {
  const engine = new InMemoryQueryEngine()
  engine.upsertMany([
    { id: 'n1', path: 'db/r1.md', title: 'r1', props: { c1: 3 } },
    { id: 'n2', path: 'db/r2.md', title: 'r2', props: { c1: 10 } },
    { id: 'x', path: 'autre/x.md', title: 'x', props: { c1: 99 } },
  ])
  const notes = new Map([['n1', text]])
  const ids: Record<string, string> = { 'db.base': 'B', 'db/r1.md': 'n1', 'db/r2.md': 'n2' }
  const editText = vi.fn(async (id: string, fn: (s: string) => string) => { notes.set(id, fn(notes.get(id) ?? '')); return true })
  const openFile = vi.fn(async () => {})
  const api = {
    query: engine,
    vault: { resolveDocumentId: (p: string) => ids[p], list: async () => Object.keys(ids), editText, createFile: vi.fn() },
    workspace: { openFile },
  } as unknown as PluginAPI
  return { api, engine, notes, editText, openFile }
}

/** Un board monte, et un faux code de board qui lui parle. */
function mount(api: PluginAPI, opts: Partial<ConstructorParameters<typeof BoardHost>[1]> = {}) {
  const host = new BoardHost(api, { boardPath: 'b.board', readOnly: false, ...opts })
  document.body.appendChild(host.frame)
  host.load('<p>board</p>')
  const channel = /const ch="([0-9a-f]+)"/.exec(host.frame.srcdoc)![1]
  const win = host.frame.contentWindow!
  const replies: Record<string, unknown>[] = []
  vi.spyOn(win, 'postMessage').mockImplementation((m: unknown) => { replies.push(m as Record<string, unknown>) })
  const send = (data: Record<string, unknown>, source: unknown = win) =>
    window.dispatchEvent(new MessageEvent('message', { data: { ch: channel, ...data }, source: source as Window }))
  const tick = () => new Promise(r => setTimeout(r, 20))
  const call = async (fn: string, ...args: unknown[]) => {
    const id = replies.length + 1000
    send({ t: 'call', id, fn, args })
    for (let i = 0; i < 20 && !replies.some(r => r.id === id); i++) await tick()
    return replies.find(r => r.id === id) as { ok: boolean; v?: unknown; e?: string }
  }
  return { host, channel, replies, send, call, tick }
}

beforeEach(() => resetBoardGrants())

describe('board : document isole', () => {
  it('CSP et pont avant le code du board ; aucun reseau ; iframe sans meme origine', () => {
    const doc = buildSrcdoc('<script>fetch("https://x")</script>', { channel: 'abc', readOnly: true, theme: '' })
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('fetch("https://x")'))
    expect(doc.indexOf('window.savoire')).toBeLessThan(doc.indexOf('fetch("https://x")'))
    expect(BOARD_CSP).toContain("default-src 'none'")
    expect(BOARD_CSP).not.toMatch(/connect-src|https?:/)
    expect(doc).toContain('readOnly:true')
    const { host } = mount(world().api)
    expect(host.frame.getAttribute('sandbox')).toBe('allow-scripts')
    host.dispose()
  })

  it('n ecoute que son iframe, sur son canal', async () => {
    const w = world()
    const { host, send, replies, tick, channel } = mount(w.api)
    send({ t: 'call', id: 1, fn: 'open', args: ['db/r1.md'] }, window)
    window.dispatchEvent(new MessageEvent('message', { data: { ch: 'autre', t: 'call', id: 2, fn: 'open', args: ['db/r1.md'] }, source: host.frame.contentWindow }))
    await tick()
    expect(w.openFile).not.toHaveBeenCalled()
    expect(replies).toEqual([])
    expect(channel).toMatch(/^[0-9a-f]{32}$/)
    host.dispose()
  })

  it('requetes : une base par son nom, avec son dossier ; suivi en direct, arrete au dechargement', async () => {
    const w = world()
    const { host, call, send, replies, tick } = mount(w.api)
    const r = await call('query', { from: 'db', aggregate: [{ op: 'sum', field: { prop: 'c1' } }] })
    expect(r.ok).toBe(true)
    expect((r.v as { aggregates: number[] }).aggregates).toEqual([13])
    expect((await call('query', { from: 'inconnue' })).e).toMatch(/introuvable/)
    expect((await call('nimporte')).e).toMatch(/inconnue/)
    send({ t: 'watch', id: 7, q: { from: { base: 'db' } } })
    await tick()
    w.engine.upsert({ id: 'n3', path: 'db/r3.md', title: 'r3', props: {} })
    await tick()
    const totals = replies.filter(m => m.t === 'watch' && m.id === 7).map(m => (m.v as { total: number }).total)
    expect(totals).toEqual([2, 3])
    host.dispose()
    w.engine.upsert({ id: 'n4', path: 'db/r4.md', title: 'r4', props: {} })
    await tick()
    expect(replies.filter(m => m.t === 'watch').length).toBe(2)
  })

  it('ecritures : refusees en lecture seule, apres accord sinon, une seule demande par board', async () => {
    const w = world()
    const ro = mount(w.api, { readOnly: true })
    expect((await ro.call('setProperty', 'db/r1.md', 'c1', 4)).e).toMatch(/Lecture seule/)
    ro.host.dispose()

    const confirmWrite = vi.fn(async () => false)
    const no = mount(w.api, { confirmWrite })
    expect((await no.call('setProperty', 'db/r1.md', 'c1', 4)).e).toMatch(/refusée/)
    no.host.dispose()
    expect(w.editText).not.toHaveBeenCalled()

    resetBoardGrants()
    const yes = vi.fn(async () => true)
    const ok = mount(w.api, { confirmWrite: yes })
    expect((await ok.call('setProperty', { id: 'n1', path: 'db/r1.md' }, 'c1', 4)).ok).toBe(true)
    expect(w.notes.get('n1')).toContain('c1: 4')
    expect((await ok.call('setProperty', 'db/r1.md', 'statut', 'Fait')).ok).toBe(true)
    expect(yes).toHaveBeenCalledTimes(1)
    // Valeurs et cibles refusees.
    expect((await ok.call('setProperty', 'db/r1.md', 'c1', { a: 1 })).e).toMatch(/valeur simple/)
    expect((await ok.call('setProperty', 'db/r1.md', 'a:b', 1)).e).toMatch(/nom de propriété/)
    expect((await ok.call('setProperty', 'inconnue.md', 'c1', 1)).e).toMatch(/introuvable/)
    expect((await ok.call('setProperty', { id: 'row1', path: '' }, 'c1', 1)).e).toMatch(/ligne légère/)
    ok.host.dispose()
  })

  it('integration : ![[x.board]]', () => {
    expect(parseBoardEmbed('![[Tableau.board]]')).toBe('Tableau.board')
    expect(parseBoardEmbed('![[dossier/T.board|alias]]')).toBe('dossier/T.board')
    expect(parseBoardEmbed('![[T.base]]')).toBeNull()
  })
})
