// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, it, expect, beforeAll } from 'vitest'
import { createWikilinksPlugin, WikilinkIndexContributor } from '@savoire/plugin-wikilinks'
import type { InputTrigger, PluginAPI } from '@savoire/plugin-api'

// Un vault a sous-dossiers : list() ne donne qu'un niveau, comme VaultClient.
const FILES = ['A/Projet.md', 'B/sous/Projet.md', 'Bible/Genese/Genèse 2.md', 'Ps. 23.md']
function list(dir?: string): string[] {
  const prefix = dir ?? ''
  const out = new Set<string>()
  for (const f of FILES) {
    if (!f.startsWith(prefix)) continue
    const rest = f.slice(prefix.length)
    const i = rest.indexOf('/')
    out.add(i < 0 ? prefix + rest : prefix + rest.slice(0, i + 1))
  }
  return [...out]
}

let trigger: InputTrigger | undefined
const stubAPI = {
  blocks: { register: () => {}, unregister: () => {}, detectBlock: () => null, getAll: () => [] },
  hooks: { beforeParse: () => {} },
  commands: { register: () => {}, unregister: () => {} },
  triggers: { register: (t: InputTrigger) => { if (t.id === 'wikilinks') trigger = t }, unregister: () => {}, getAll: () => [], findConflict: () => undefined },
  files: { register: () => {}, unregister: () => {}, getAll: () => [], getByExtension: () => undefined },
  views: { register: () => {}, unregister: () => {}, getAll: () => [] },
  index: { register: () => {}, registerFactory: () => {}, unregister: () => {}, getAll: () => [], rebuild: () => {} },
  vault: { list: async (dir?: string) => list(dir) },
} as unknown as PluginAPI

beforeAll(async () => {
  await createWikilinksPlugin().onload(stubAPI)
  await new Promise(r => setTimeout(r, 10))
})

const items = (q: string) => trigger!.handler!.getItems(q)

describe('autocompletion [[ : notes de tous les dossiers, lien comme Obsidian', () => {
  it('trouve une note dans un sous-dossier, insere son nom seul', () => {
    const genese = items('Gen')
    expect(genese.map(i => i.insert)).toEqual(['[[Genèse 2]]'])
  })
  it('nom porte par deux notes : le lien porte le chemin', () => {
    expect(items('Proj').map(i => i.insert).sort()).toEqual(['[[A/Projet]]', '[[B/sous/Projet]]'])
  })
  it('un point dans le nom reste dans le lien', () => {
    expect(items('Ps').map(i => i.insert)).toEqual(['[[Ps. 23]]'])
  })
})

describe('retroliens resolus comme Obsidian', () => {
  it('un nom ambigu ne vise qu\'une note', () => {
    const c = new WikilinkIndexContributor()
    c.onEntriesChanged(new Map([
      ['d1', c.computeEntries('d1', 'etude.md', 'Voir [[Projet]] et ![[Genèse 2#^2]]')],
      ['d2', c.computeEntries('d2', 'autre.md', 'Voir [[B/sous/Projet]]')],
    ]))
    expect(c.getBacklinks('A/Projet.md', FILES).map(b => b.docId)).toEqual(['d1'])
    expect(c.getBacklinks('B/sous/Projet.md', FILES).map(b => b.docId)).toEqual(['d2'])
    expect(c.getBacklinks('Bible/Genese/Genèse 2.md', FILES).map(b => b.docId)).toEqual(['d1'])
  })
})
