// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect } from 'vitest'
import type { ISharedMap } from '@savoire/plugin-api'
import { VersionRecorder, listVersions, diffLines, diffStats, VERSION_INTERVAL_MS, MAX_VERSIONS } from '@savoire/plugin-history'

function memoryMap(): ISharedMap {
  const data = new Map<string, unknown>()
  return {
    set: (k, v) => { data.set(k, v) },
    delete: k => { data.delete(k) },
    getAll: () => [...data].map(([id, value]) => ({ id, value })),
    onChange: () => () => {},
  }
}

function setup(name = 'Ana') {
  let now = Date.UTC(2026, 10, 7, 9, 0)
  const map = memoryMap()
  const recorder = new VersionRecorder({ openMap: () => map, me: () => ({ id: name.toLowerCase(), name }), now: () => now })
  return { map, recorder, advance: (ms: number) => { now += ms } }
}

describe('VersionRecorder', () => {
  it('garde le texte d\'avant, puis une version a la premiere frappe', () => {
    const { map, recorder } = setup()
    recorder.observe('d', 'avant', false)
    recorder.observe('d', 'avant et apres', true)
    const v = listVersions(map)
    expect(v.map(x => [x.author?.name ?? null, x.text])).toEqual([['Ana', 'avant et apres'], [null, 'avant']])
  })

  it('une version au plus toutes les 5 minutes, la derniere au flush', () => {
    const { map, recorder, advance } = setup()
    recorder.observe('d', 'a', true)
    advance(60_000); recorder.observe('d', 'ab', true)
    advance(60_000); recorder.observe('d', 'abc', true)
    expect(listVersions(map).map(v => v.text)).toEqual(['a'])
    advance(VERSION_INTERVAL_MS); recorder.tick()
    expect(listVersions(map).map(v => v.text)).toEqual(['abc', 'a'])
    advance(1000); recorder.observe('d', 'abcd', true)
    recorder.flush()
    expect(listVersions(map).map(v => v.text)).toEqual(['abcd', 'abc', 'a'])
  })

  it('n\'enregistre pas ce qui vient d\'un pair', () => {
    const { map, recorder } = setup()
    recorder.observe('d', 'texte d\'un autre', false)
    recorder.flush()
    expect(listVersions(map)).toEqual([])
  })

  it('restaurer ecrit le texte et devient une version', async () => {
    const { map, recorder, advance } = setup()
    recorder.observe('d', 'v1', true)
    advance(VERSION_INTERVAL_MS); recorder.observe('d', 'v2', true)
    const old = listVersions(map).find(v => v.text === 'v1')!
    let written = ''
    advance(1000)
    await recorder.restore('d', old, async (_id, text) => { written = text; return true })
    expect(written).toBe('v1')
    const [last] = listVersions(map)
    expect(last.text).toBe('v1')
    expect(last.restoredFrom).toBe(old.at)
    expect(listVersions(map)).toHaveLength(3)
  })

  it('ne garde que les plus recentes', () => {
    const { map, recorder, advance } = setup()
    for (let i = 0; i < MAX_VERSIONS + 5; i++) { advance(VERSION_INTERVAL_MS); recorder.observe('d', `t${i}`, true) }
    const v = listVersions(map)
    expect(v).toHaveLength(MAX_VERSIONS)
    expect(v[0].text).toBe(`t${MAX_VERSIONS + 4}`)
  })
})

describe('diffLines', () => {
  it('lignes gardees, ajoutees, retirees', () => {
    expect(diffLines('a\nb\nc', 'a\nx\nc\nd')).toEqual([
      { kind: 'same', text: 'a' },
      { kind: 'del', text: 'b' },
      { kind: 'add', text: 'x' },
      { kind: 'same', text: 'c' },
      { kind: 'add', text: 'd' },
    ])
    expect(diffStats('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 })
    expect(diffStats('', 'a\nb')).toEqual({ added: 2, removed: 1 })
  })
})
