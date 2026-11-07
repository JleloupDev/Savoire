// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import { parseDsn, eventOf, withErrorReports } from '../../../../../apps/indexer/src/errorReport'

describe('rapports d\'erreur du pair', () => {
  it('lit un DSN', () => {
    expect(parseDsn('http://abc@glitchtip:8000/3')).toEqual({ url: 'http://glitchtip:8000/api/3/envelope/', key: 'abc' })
    expect(parseDsn('https://k@exemple.fr/errors/12')).toEqual({ url: 'https://exemple.fr/errors/api/12/envelope/', key: 'k' })
    expect(parseDsn('http://glitchtip:8000/3')).toBeNull()
    expect(parseDsn('n importe quoi')).toBeNull()
  })

  it('ne transforme que les erreurs', () => {
    const opts = { environment: 'production', release: 'v1', serverName: 'idx-a' }
    expect(eventOf(JSON.stringify({ level: 'info', msg: 'ok' }), opts)).toBeNull()
    const ev = eventOf(JSON.stringify({ t: '2026-11-07T10:00:00.000Z', level: 'error', msg: 'lecture impossible', err: { name: 'TypeError', message: 'x' }, vault: 'v1' }), opts)!
    expect(ev['exception']).toEqual({ values: [{ type: 'TypeError', value: 'lecture impossible : x' }] })
    expect(ev['extra']).toEqual({ vault: 'v1' })
    expect(ev['release']).toBe('v1')
  })

  it('ecrit toujours, envoie les erreurs, avec une limite par minute', async () => {
    const written: string[] = []
    const sent: { url: string; body: string }[] = []
    const sink = withErrorReports(l => written.push(l), {
      dsn: 'http://abc@glitchtip:8000/3', environment: 'p', release: 'r', serverName: 's', maxPerMinute: 2,
      send: async (url, _h, body) => { sent.push({ url, body }) },
    })
    sink(JSON.stringify({ level: 'info', msg: 'a' }))
    for (let i = 0; i < 3; i++) sink(JSON.stringify({ level: 'error', msg: 'b' + i }))
    await new Promise(r => setTimeout(r, 0))
    expect(written).toHaveLength(4)
    expect(sent).toHaveLength(2)
    expect(sent[0].url).toBe('http://glitchtip:8000/api/3/envelope/')
    expect(sent[0].body.split('\n')[1]).toBe('{"type":"event"}')
  })
})
