// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le contexte de l'editeur pour l'IA : l'entree construite a chaque
// selection (section, mots autour, ancre), la memoire courte, et les outils
// get_context / list_pins de l'assistant de l'appli.
import { describe, it, expect } from 'vitest'
import {
  EditorContextRing, MAX_CONTEXT_SELECTION, ToolBox, buildAnchor, buildEditorContext, coreCatalog, headingPathAt, locateByQuote,
  sameEditorContext, wordsAfter, wordsBefore,
  type AiMark, type EditorContextEntry,
} from '@savoire/agent-core'
import { splitNoteBlocks, type AgentDefinition, type ToolActor } from '@savoire/plugin-api'
import { MemoryHost } from './memoryHost'

/** Un faux codeur de position relative : on y lit la position et le cote. */
const encode = (i: number, assoc: 0 | -1): string => `${i}:${assoc}`

const NOTE = [
  '---',
  'titre: Plan',
  '---',
  '# MCP',
  '',
  'Le serveur parle aux IA par des outils.',
  '',
  '## Bases ^b1',
  '',
  'Une base range des lignes. Chaque ligne a des propriétés, et une vue les montre triées ou filtrées selon le besoin du moment.',
  '',
  '### Vues',
  '',
  '- en tableau',
  '- en **kanban**',
  '',
  '## Notes',
  '',
  'Une note est un texte.',
].join('\n')

function entryAt(needle: string, length = needle.length): EditorContextEntry {
  const from = NOTE.indexOf(needle)
  return buildEditorContext({ vaultId: 'v', docId: 'd', path: 'Projets/Plan.md', text: NOTE, from, to: from + length, tabId: 'onglet', at: 1000, encode })
}

describe('entree de contexte', () => {
  it('le chemin des titres : du plus haut au plus proche, sans marques ni identifiant', () => {
    const blocks = splitNoteBlocks(NOTE)
    const at = (needle: string) => headingPathAt(blocks, NOTE.indexOf(needle))
    expect(at('titre: Plan')).toEqual([])
    expect(at('Le serveur')).toEqual(['MCP'])
    expect(at('Une base')).toEqual(['MCP', 'Bases'])
    expect(at('en tableau')).toEqual(['MCP', 'Bases', 'Vues'])
    // Un titre de meme niveau remplace le precedent, et ferme ses sous-titres.
    expect(at('Une note')).toEqual(['MCP', 'Notes'])
    // Dans un titre : lui-meme compte.
    expect(at('Bases ^b1')).toEqual(['MCP', 'Bases'])
    // Un titre de niveau 2 sans titre 1 au-dessus.
    expect(headingPathAt(splitNoteBlocks('## Seul\n\ntexte'), 10)).toEqual(['Seul'])
  })

  it('une selection : son texte, la section, le bloc, dix mots avant et apres', () => {
    const e = entryAt('Chaque ligne a des propriétés')
    expect(e).toMatchObject({ vaultId: 'v', docId: 'd', path: 'Projets/Plan.md', tabId: 'onglet', at: 1000 })
    expect(e.selection).toBe('Chaque ligne a des propriétés')
    expect(e.selectionTruncated).toBeUndefined()
    expect(e.headingPath).toEqual(['MCP', 'Bases'])
    expect(e.before).toBe('des outils. ## Bases ^b1 Une base range des lignes.')
    expect(e.before.split(' ')).toHaveLength(10)
    expect(e.after).toBe(', et une vue les montre triées ou filtrées selon')
    const block = splitNoteBlocks(NOTE).find(b => b.text.startsWith('Une base'))!
    expect(e.blockHash).toBe(block.hash)
  })

  it('l ancre : positions relatives, texte, 32 caracteres avant et apres', () => {
    const from = NOTE.indexOf('Chaque ligne')
    const e = entryAt('Chaque ligne a des propriétés')
    // Debut colle au caractere qui suit, fin a celui qui precede.
    expect(e.anchor).toEqual({
      docId: 'd', start: `${from}:0`, end: `${from + 29}:-1`, quote: 'Chaque ligne a des propriétés',
      prefix: NOTE.slice(from - 32, from), suffix: NOTE.slice(from + 29, from + 29 + 32),
    })
    expect(e.anchor.prefix).toHaveLength(32)
    expect(e.anchor.prefix.endsWith('Une base range des lignes. ')).toBe(true)
    expect(e.anchor.suffix.startsWith(', et une vue')).toBe(true)
    // Au debut et a la fin de la note : ce qu'il y a, pas plus.
    const first = buildAnchor({ docId: 'd', text: 'abc', from: 0, to: 3, encode })
    expect(first).toMatchObject({ prefix: '', suffix: '', quote: 'abc' })
  })

  it('un curseur : selection vide, fin = debut, l endroit par ce qui l entoure', () => {
    const e = entryAt('en tableau', 0)
    expect(e.selection).toBe('')
    expect(e.anchor.quote).toBe('')
    expect(e.anchor.end).toBe(e.anchor.start)
    expect(e.anchor.start).toBe(`${NOTE.indexOf('en tableau')}:0`)
    expect(e.before.endsWith('### Vues -')).toBe(true)
    expect(e.after.startsWith('en tableau - en **kanban**')).toBe(true)
    expect(e.headingPath).toEqual(['MCP', 'Bases', 'Vues'])
  })

  it('une selection trop longue est coupee, pas son ancre ; des bornes folles sont ramenees dans le texte', () => {
    const text = `Début ${'x'.repeat(MAX_CONTEXT_SELECTION + 500)} fin`
    const e = buildEditorContext({ vaultId: 'v', docId: 'd', path: 'a.md', text, from: 6, to: text.length - 4, tabId: 't', at: 1, encode })
    expect(e.selection).toHaveLength(MAX_CONTEXT_SELECTION)
    expect(e.selectionTruncated).toBe(true)
    expect(e.anchor.end).toBe(`${text.length - 4}:-1`)
    expect(e.after).toBe('fin')
    const wild = buildEditorContext({ vaultId: 'v', docId: 'd', path: 'a.md', text: 'court', from: 99, to: -5, tabId: 't', at: 1, encode })
    expect(wild.selection).toBe('court')
    // Une selection a l'envers (to < from) est la meme.
    const back = buildAnchor({ docId: 'd', text: 'un deux trois', from: 7, to: 3, encode })
    expect(back.quote).toBe('deux')
  })

  it('les mots autour : au plus dix, sans retours a la ligne', () => {
    const text = 'un deux trois quatre cinq six sept huit neuf dix onze douze\ntreize quatorze'
    const pos = text.indexOf('douze')
    expect(wordsBefore(text, pos)).toBe('deux trois quatre cinq six sept huit neuf dix onze')
    expect(wordsAfter(text, pos, 2)).toBe('douze treize')
    expect(wordsBefore(text, 0)).toBe('')
    expect(wordsAfter(text, text.length)).toBe('')
  })

  it('deux entrees pour le meme passage se valent, quel que soit l instant', () => {
    const a = entryAt('Chaque ligne')
    expect(sameEditorContext(a, { ...a, at: 99999 })).toBe(true)
    expect(sameEditorContext(a, entryAt('Chaque ligne a'))).toBe(false)
    expect(sameEditorContext(a, null)).toBe(false)
    expect(sameEditorContext(null, null)).toBe(true)
  })
})

describe('retrouver un passage par son texte', () => {
  const text = 'Le chat dort. Le chien court. Le chat mange.'
  it('la seule occurrence, ou celle que son entourage designe', () => {
    expect(locateByQuote(text, { quote: 'chien', prefix: '', suffix: '' })).toEqual({ from: 17, to: 22 })
    // « chat » deux fois : l'entourage tranche.
    expect(locateByQuote(text, { quote: 'chat', prefix: 'court. Le ', suffix: ' mange' })).toEqual({ from: 33, to: 37 })
    expect(locateByQuote(text, { quote: 'chat', prefix: 'autre ', suffix: ' chose' })).toBeNull()
    expect(locateByQuote(text, { quote: 'poisson', prefix: '', suffix: '' })).toBeNull()
  })
  it('un curseur : entre ce qui le precedait et ce qui le suivait', () => {
    expect(locateByQuote(text, { quote: '', prefix: 'chien ', suffix: 'court' })).toEqual({ from: 23, to: 23 })
    expect(locateByQuote(text, { quote: '', prefix: 'Le ', suffix: 'ch' })).toBeNull()
    expect(locateByQuote(text, { quote: '', prefix: '', suffix: '' })).toBeNull()
  })
})

describe('memoire courte du contexte', () => {
  const e = (docId: string, at: number): EditorContextEntry => ({ ...entryAt('Une base'), docId, at })

  it('garde une minute, et toujours la derniere entree', () => {
    const ring = new EditorContextRing()
    ring.push(e('a', 0))
    ring.push(e('b', 30_000))
    ring.push(e('c', 80_000))
    // « a » a plus d'une minute de retard sur la derniere : elle sort.
    expect(ring.at(9999, 80_000)?.entry.docId).toBe('b')
    // Longtemps apres, sans rien de neuf : la derniere est toujours la, avec son age.
    expect(ring.at(0, 4_000_000)).toMatchObject({ entry: { docId: 'c' }, ageSeconds: 3920 })
    ring.push(e('d', 5_000_000))
    expect(ring.at(9999, 5_000_000)?.entry.docId).toBe('d')
    expect(new EditorContextRing().at(0, 0)).toBeNull()
  })

  it('il y a n secondes : ou etait la personne a ce moment, pas l entree la plus proche', () => {
    const ring = new EditorContextRing()
    ring.push(e('selection', 0))
    ring.push(e('ailleurs', 8000))
    expect(ring.at(0, 10_000)?.entry.docId).toBe('ailleurs')
    expect(ring.at(5, 10_000)).toMatchObject({ entry: { docId: 'selection' }, ageSeconds: 10 })
    expect(ring.at(3000, 10_000)?.entry.docId).toBe('selection')
    expect(ring.last()?.docId).toBe('ailleurs')
  })

  it('reste bornee', () => {
    const ring = new EditorContextRing(60, 8)
    for (let i = 0; i < 50; i++) ring.push(e(`n${i}`, i))
    expect(ring.at(9999, 50)?.entry.docId).toBe('n42')
  })
})

// ── Outils de l'assistant de l'appli ────────────────────────────────────────

const actor: ToolActor = { agentId: 'a1', agentName: 'Secrétaire', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }

function agent(p: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'a1', name: 'Secrétaire', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct' }, ...p }
}

class EditorHost extends MemoryHost {
  context: { entry: EditorContextEntry; ageSeconds: number } | null = null
  marks: AiMark[] = []
  asked: number[] = []
  async editorContext(p: { secondsAgo: number }) { this.asked.push(p.secondsAgo); return this.context }
  async aiMarks(kind: AiMark['kind']) { return this.marks.filter(m => m.kind === kind) }
}

function mark(kind: AiMark['kind'], label: string, path: string, quote: string): AiMark {
  return { id: `${kind}-${label || quote}`, vaultId: 'v', docId: 'd', kind, label, path, anchor: { docId: 'd', start: 'AAE=', end: 'AAI=', quote, prefix: '', suffix: '' }, createdAt: '2026-11-24T10:00:00Z' }
}

const box = (host: MemoryHost, a: AgentDefinition, runtime: 'app' | 'server' = 'app') =>
  new ToolBox({ agent: a, person: { canWrite: true }, actor, runtime, host })

describe('outils get_context et list_pins (appli)', () => {
  it('offerts dans l appli a qui peut lire ; le pair ne les a pas (le serveur les sert lui-meme)', () => {
    const names = box(new EditorHost(), agent()).specs().map(s => s.name)
    expect(names).toEqual(expect.arrayContaining(['get_context', 'list_pins']))
    expect(coreCatalog('server').map(s => s.name)).not.toContain('get_context')
    expect(coreCatalog('server').map(s => s.name)).not.toContain('list_pins')
    expect(box(new EditorHost(), agent({ permissions: { read: 'deny' } })).specs().map(s => s.name)).not.toContain('get_context')
    const spec = box(new EditorHost(), agent()).specs().find(s => s.name === 'get_context')!
    expect(spec.action).toBe('read')
    expect(spec.description).toContain('« ici »')
  })

  it('la selection, la section, l ancre, et un conseil selon l age', async () => {
    const host = new EditorHost()
    host.context = { entry: entryAt('Chaque ligne a des propriétés'), ageSeconds: 12 }
    host.marks = [mark('highlight', '', 'Projets/Plan.md', 'un passage marqué')]
    const r = await box(host, agent()).call('get_context', { seconds_ago: 20 })
    expect(host.asked).toEqual([20])
    expect(r.result.isError).toBeFalsy()
    expect(r.result.text).toContain('Chaque ligne a des propriétés')
    expect(r.result.text).toContain('Section : MCP > Bases')
    expect(r.result.text).toContain('il y a 12 s')
    expect(r.result.text).toContain('un passage marqué')
    expect(r.result.data).toMatchObject({
      noteId: 'd', path: 'Projets/Plan.md', ageSeconds: 12, stale: false, isCursor: false,
      anchor: { quote: 'Chaque ligne a des propriétés' }, highlights: [{ text: 'un passage marqué', path: 'Projets/Plan.md' }],
    })
    expect(r.result.sources?.map(s => s.path)).toEqual(['Projets/Plan.md'])

    // Plus de deux minutes : confirmer avant d'agir.
    host.context = { entry: entryAt('en tableau', 0), ageSeconds: 300 }
    const old = await box(host, agent()).call('get_context', {})
    expect(old.result.data).toMatchObject({ stale: true, isCursor: true })
    expect(old.result.text).toContain('confirmer')
    expect(old.result.text).toContain('le curseur est entre')
    // Un nombre fou ne casse rien.
    await box(host, agent()).call('get_context', { seconds_ago: -4 })
    await box(host, agent()).call('get_context', { seconds_ago: 1e9 })
    expect(host.asked.slice(-2)).toEqual([0, 3600])
  })

  it('rien d ouvert : l IA le sait ; hors de la portee de l agent : rien ne sort', async () => {
    const host = new EditorHost()
    const none = await box(host, agent()).call('get_context', {})
    expect(none.result.text).toContain('Aucun contexte')
    expect(none.result.data).toEqual({ highlights: [] })

    host.context = { entry: entryAt('Chaque ligne'), ageSeconds: 3 }
    host.marks = [mark('highlight', '', 'Projets/Plan.md', 'passage secret'), mark('highlight', '', 'Public/a.md', 'passage public'), mark('pin', 'Secrète', 'Projets/Plan.md', 'x'), mark('pin', 'Publique', 'Public/b.md', '')]
    const scoped = box(host, agent({ scope: { folders: ['Public'] } }))
    const r = await scoped.call('get_context', {})
    expect(r.result.text).toContain('hors de la portée')
    expect(JSON.stringify(r.result)).not.toContain('Chaque ligne')
    expect(JSON.stringify(r.result)).not.toContain('passage secret')
    expect(r.result.data).toMatchObject({ highlights: [{ text: 'passage public' }] })
    const pins = await scoped.call('list_pins', {})
    expect(pins.result.text).toContain('1 épingle(s)')
    expect(pins.result.text).toContain('Publique')
    expect(pins.result.text).toContain('un endroit (curseur)')
    expect(JSON.stringify(pins.result)).not.toContain('Secrète')
  })

  it('les epingles par leur nom ; un hote sans editeur le dit', async () => {
    const host = new EditorHost()
    expect((await box(host, agent()).call('list_pins', {})).result.text).toContain('Aucune épingle')
    host.marks = [mark('pin', 'Conclusion', 'Projets/Plan.md', 'le dernier paragraphe'), mark('highlight', '', 'Projets/Plan.md', 'surligné')]
    const pins = await box(host, agent()).call('list_pins', {})
    expect(pins.result.text).toContain('Conclusion')
    expect(pins.result.text).toContain('le dernier paragraphe')
    expect(pins.result.text).not.toContain('surligné')
    expect(pins.result.data).toMatchObject({ pins: [{ label: 'Conclusion', noteId: 'd', anchor: { start: 'AAE=' } }] })
    const bare = box(new MemoryHost(), agent())
    expect((await bare.call('get_context', {})).result.isError).toBe(true)
    expect((await bare.call('list_pins', {})).result.isError).toBe(true)
  })
})
