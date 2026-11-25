// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lire et ecrire une note par morceaux (ADR-033) : references de bloc,
// sections, lignes, versions et memoire de l'agent, retouches (patch_note),
// ancres de l'editeur, effet de frappe, presence.
import { describe, it, expect } from 'vitest'
import {
  ReadMemory, ToolBox, anchorOf, findSections, locateAnchor, mergeSnapshot, noteSections, parseLines, planTyping, refBlocks, resolveAnchor, snapshotOf, stripRefLines,
  typingChunks, TYPING_MIN_CHARS,
  type TextChange,
} from '@savoire/agent-core'
import type { AgentDefinition, ToolActor } from '@savoire/plugin-api'
import { textFingerprint } from '@savoire/plugin-api'
import { HostError } from '@savoire/agent-core'
import { MemoryHost } from './memoryHost'

const actor: ToolActor = { agentId: 'a1', agentName: 'Archiviste', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const other: ToolActor = { agentId: 'a2', agentName: 'Relecteur', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }

function agent(p: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'a1', name: 'Archiviste', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', edit: 'direct' }, ...p }
}

/** Un hote qui sait ecrire plusieurs changements d'un coup, et qui note la presence. */
class FineHost extends MemoryHost {
  signals: string[] = []
  batches: { changes: TextChange[]; typing: boolean }[] = []
  /** Positions relatives « resolues » par l'hote (test) : start -> plage. */
  relative = new Map<string, { from: number; to: number }>()
  /** Appele juste avant d'ecrire : pour glisser une modification d'une autre personne. */
  beforeWrite?: () => void

  signal(s: { docId: string; state: string; from?: number; to?: number }): void {
    this.signals.push(`${s.state}${s.from !== undefined ? ` ${s.from}-${s.to}` : ''}`)
  }

  async applyChanges(docId: string, changes: readonly TextChange[], _actor: ToolActor, opts: { typing?: boolean; expect?: string } = {}): Promise<void> {
    this.beforeWrite?.()
    this.beforeWrite = undefined
    const n = this.notes.get(docId)!
    if (opts.expect !== undefined && textFingerprint(n.content) !== opts.expect) throw new HostError('La note a changé pendant la modification : relisez-la.', 'conflict')
    let out = ''
    let at = 0
    for (const c of changes) {
      out += n.content.slice(at, c.from) + c.text
      at = c.to
    }
    n.content = out + n.content.slice(at)
    this.batches.push({ changes: [...changes], typing: !!opts.typing })
    this.writes.push(`patch ${n.path}`)
  }

  async resolveRelative(_docId: string, start: string): Promise<{ from: number; to: number } | null> {
    return this.relative.get(start) ?? null
  }
}

function box(host: MemoryHost, opts: { memory?: ReadMemory; who?: ToolActor; mode?: 'propose'; a?: AgentDefinition } = {}): ToolBox {
  return new ToolBox({
    agent: opts.a ?? agent(), person: { canWrite: true }, actor: opts.who ?? actor, runtime: 'app', host,
    memory: opts.memory ?? new ReadMemory(), ...(opts.mode ? { imposedMode: opts.mode } : {}),
  })
}

const NOTE = [
  '---', 'statut: brouillon', '---',
  '# Plan',
  '',
  'Introduction du plan. ^intro',
  '',
  '## MCP',
  '',
  'Le serveur MCP parle aux IA.',
  '',
  '### Bases',
  '',
  '- une ligne',
  '- deux lignes',
  '',
  '## Suite',
  '',
  'La suite du plan.',
  '',
  '### Bases',
  '',
  'Autre section du même nom.',
].join('\n')

const refOf = (text: string, startsWith: string): string => refBlocks(text).find(b => b.text.startsWith(startsWith))!.ref
const versionOf = (text: string): string => /Version : (v[0-9a-f]+)/.exec(text)![1]!

describe('references de bloc', () => {
  it('chaque bloc lu porte sa reference : son ^id, sinon le debut de son empreinte', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const r = await box(host).call('read_note', { path: 'Plan.md' })
    expect(r.result.isError).toBeFalsy()
    const text = r.result.text
    expect(text).toContain('‹^intro›\nIntroduction du plan. ^intro')
    expect(text).toMatch(/‹[0-9a-f]{8}›\n## MCP/)
    expect(text).toMatch(/Version : v[0-9a-f]{10}/)
    // Sans les lignes de reference, c'est la note, telle quelle.
    const body = text.slice(text.indexOf('\n\n') + 2)
    expect(stripRefLines(body)).toBe(NOTE)
  })

  it('deux blocs de meme texte : le deuxieme porte ~2', () => {
    const blocks = refBlocks('pareil\n\nautre\n\npareil')
    expect(blocks.map(b => b.ref)).toEqual([blocks[0]!.hash.slice(0, 8), blocks[1]!.hash.slice(0, 8), `${blocks[0]!.hash.slice(0, 8)}~2`])
    expect(blocks.map(b => [b.line, b.lastLine])).toEqual([[1, 1], [3, 3], [5, 5]])
  })

  it('un fichier qui n est pas une note garde son texte brut', async () => {
    const host = new FineHost({ 'Doc.pdf': 'page un\npage deux\npage trois' })
    const all = await box(host).call('read_note', { path: 'Doc.pdf' })
    expect(all.result.text).toBe(`# Doc.pdf (id : ${host.idOf('Doc.pdf')})\n\npage un\npage deux\npage trois`)
    const some = await box(host).call('read_note', { path: 'Doc.pdf', lines: '2-3' })
    expect(some.result.text).toContain('Lignes 2-3 sur 3.\n\npage deux\npage trois')
  })
})

describe('lecture partielle', () => {
  it('une section par son titre : elle seule, sous-sections comprises', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const r = await box(host).call('read_note', { path: 'Plan.md', section: 'mcp' })
    expect(r.result.text).toContain('section « Plan > MCP », lignes 8-15 sur 23')
    expect(r.result.text).toContain('Le serveur MCP parle aux IA.')
    expect(r.result.text).toContain('- deux lignes')
    expect(r.result.text).not.toContain('Introduction du plan')
    expect(r.result.text).not.toContain('La suite du plan')
  })

  it('un chemin « MCP > Bases » choisit la bonne section ; un titre ambigu le dit', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    const exact = await tb.call('read_note', { path: 'Plan.md', section: 'Suite > Bases' })
    expect(exact.result.text).toContain('Autre section du même nom.')
    expect(exact.result.text).not.toContain('- une ligne')
    const vague = await tb.call('read_note', { path: 'Plan.md', section: 'Bases' })
    expect(vague.result.text).toContain('- une ligne')
    expect(vague.result.text).toContain('2 sections portent ce titre')
    expect(vague.result.text).toContain('« Plan > Suite > Bases » (ligne 21)')
  })

  it('une section inconnue rend le plan de la note', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const r = await box(host).call('read_note', { path: 'Plan.md', section: 'Budget' })
    expect(r.result.isError).toBe(true)
    expect(r.result.text).toContain('Section introuvable : « Budget »')
    expect(r.result.text).toContain('  - MCP (lignes 8-15)')
  })

  it('des lignes : les blocs qui les touchent, entiers', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const r = await box(host).call('read_note', { path: 'Plan.md', lines: '10-14' })
    expect(r.result.text).toContain('lignes 10-15 sur 23')
    expect(r.result.text).toContain('Le serveur MCP parle aux IA.')
    expect(r.result.text).toContain('- deux lignes')
    expect(r.result.text).not.toContain('## MCP')
    expect((await box(host).call('read_note', { path: 'Plan.md', lines: '90-99' })).result.isError).toBe(true)
    expect(parseLines('10-40')).toEqual({ from: 10, to: 40 })
    expect(parseLines('7')).toEqual({ from: 7, to: 7 })
    expect(parseLines('40-10')).toBeNull()
  })

  it('le plan seul : titres, lignes, references', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const r = await box(host).call('read_note', { path: 'Plan.md', outline: true })
    expect(r.result.text).toContain('- Plan (lignes 4-23)')
    expect(r.result.text).toContain('    - Bases (lignes 12-15)')
    expect(r.result.text).not.toContain('Le serveur MCP')
  })

  it('sections : titres mis en forme, chemins', () => {
    const s = noteSections(refBlocks('# **Un**\n\n## Deux ^d\n\ntexte\n\n# Trois'))
    expect(s.map(x => x.path.join(' > '))).toEqual(['Un', 'Un > Deux', 'Trois'])
    expect(s.map(x => [x.first, x.last])).toEqual([[0, 2], [1, 2], [3, 3]])
    expect(findSections(s, 'un > DEUX')).toHaveLength(1)
    expect(findSections(s, 'Trois > Deux')).toHaveLength(0)
  })
})

describe('changements depuis une version', () => {
  it('since: <jeton> ne rend que les blocs modifies, ajoutes, supprimes', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    const first = await tb.call('read_note', { path: 'Plan.md' })
    const token = versionOf(first.result.text)
    const was = refOf(NOTE, 'Le serveur MCP')
    const gone = refOf(NOTE, 'La suite du plan')
    const n = host.notes.get(host.idOf('Plan.md'))!
    n.content = n.content
      .replace('Le serveur MCP parle aux IA.', 'Le serveur MCP parle à ChatGPT et à Claude.')
      .replace('La suite du plan.\n\n', '')
      .replace('- deux lignes', '- deux lignes\n\nUn paragraphe en plus.')
    const r = await tb.call('read_note', { path: 'Plan.md', since: token })
    const text = r.result.text
    expect(text).toContain(`Depuis ${token} : 1 bloc(s) modifié(s), 1 ajouté(s), 1 supprimé(s).`)
    expect(text).toContain(`modifié (était ‹${was}›), ligne 10, section « MCP »\nLe serveur MCP parle à ChatGPT et à Claude.`)
    expect(text).toContain('ajouté, ligne 17, section « Bases »\nUn paragraphe en plus.')
    expect(text).toContain(`‹${gone}› supprimé`)
    // Rien de ce qui n'a pas bouge.
    expect(text).not.toContain('Introduction du plan')
    expect(text).not.toContain('- une ligne')
    expect(versionOf(text)).not.toBe(token)
    // Le meme texte donne le meme jeton.
    expect(versionOf((await tb.call('read_note', { path: 'Plan.md', since: versionOf(text) })).result.text)).toBe(versionOf(text))
  })

  it('since: last : ce qui a change depuis MA derniere lecture, agent par agent', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const memory = new ReadMemory()
    const mine = box(host, { memory })
    const theirs = box(host, { memory, who: other, a: agent({ id: 'a2', name: 'Relecteur' }) })
    await mine.call('read_note', { path: 'Plan.md' })
    const n = host.notes.get(host.idOf('Plan.md'))!
    n.content = n.content.replace('La suite du plan.', 'La suite, revue.')
    const r = await mine.call('read_note', { path: 'Plan.md', since: 'last' })
    expect(r.result.text).toContain('Depuis votre dernière lecture : 1 bloc(s) modifié(s), 0 ajouté(s), 0 supprimé(s).')
    expect(r.result.text).toContain('La suite, revue.')
    expect(r.result.text).not.toContain('Introduction du plan')
    // Relu : plus rien a signaler.
    expect((await mine.call('read_note', { path: 'Plan.md', since: 'last' })).result.text).toContain('Rien n’a changé depuis votre dernière lecture.')
    // L'autre agent n'a jamais lu : on le lui dit, et il recoit tout.
    const cold = await theirs.call('read_note', { path: 'Plan.md', since: 'last' })
    expect(cold.result.text).toContain('Aucune lecture précédente en mémoire')
    expect(cold.result.text).toContain('Introduction du plan')
  })

  it('jeton oublie ou inconnu : dit, puis le texte entier', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const r = await box(host).call('read_note', { path: 'Plan.md', since: 'v0000000000' })
    expect(r.result.isError).toBeFalsy()
    expect(r.result.text).toContain('Version v0000000000 oubliée ou inconnue')
    expect(r.result.text).toContain('Introduction du plan')
    expect(r.result.text).toContain('La suite du plan.')
  })

  it('une lecture partielle ne fait pas oublier ce qui a change ailleurs', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md' })
    const n = host.notes.get(host.idOf('Plan.md'))!
    n.content = n.content.replace('La suite du plan.', 'La suite, revue.').replace('Le serveur MCP parle aux IA.', 'Le serveur MCP, revu.')
    // Il relit la section MCP seulement : il connait maintenant ce bloc-la...
    expect((await tb.call('read_note', { path: 'Plan.md', section: 'MCP' })).result.text).toContain('Le serveur MCP, revu.')
    // ... mais pas la suite : on la lui signale encore, et elle seule.
    const r = await tb.call('read_note', { path: 'Plan.md', since: 'last' })
    expect(r.result.text).toContain('1 bloc(s) modifié(s), 0 ajouté(s), 0 supprimé(s)')
    expect(r.result.text).toContain('La suite, revue.')
    expect(r.result.text).not.toContain('Le serveur MCP, revu.')
  })

  it('since avec section : les changements de cette section seulement, autant de fois qu on veut', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md' })
    const n = host.notes.get(host.idOf('Plan.md'))!
    n.content = n.content.replace('La suite du plan.', 'La suite, revue.').replace('Le serveur MCP parle aux IA.', 'Le serveur MCP, revu.')
    const r = await tb.call('read_note', { path: 'Plan.md', since: 'last', section: 'MCP' })
    expect(r.result.text).toContain('Le serveur MCP, revu.')
    expect(r.result.text).not.toContain('La suite, revue.')
    expect((await tb.call('read_note', { path: 'Plan.md', since: 'last', section: 'MCP' })).result.text).toContain('Rien n’a changé')
    expect((await tb.call('read_note', { path: 'Plan.md', since: 'last' })).result.text).toContain('La suite, revue.')
  })

  it('la memoire est bornee : la plus anciennement servie part la premiere', () => {
    const memory = new ReadMemory(3)
    const snap = (i: number) => snapshotOf(`d${i}`, `texte ${i}`)
    for (let i = 0; i < 3; i++) memory.remember(snap(i))
    expect(memory.version('d0', snap(0).token)).toBeDefined() // servie : redevient recente
    memory.remember(snap(3))
    expect(memory.size).toBe(3)
    expect(memory.version('d1', snap(1).token)).toBeUndefined()
    expect(memory.version('d0', snap(0).token)).toBeDefined()
    // Borne aussi par le nombre de blocs gardes.
    const small = new ReadMemory(100, 5)
    small.remember(snapshotOf('a', 'un\n\ndeux\n\ntrois'))
    small.remember(snapshotOf('b', 'un\n\ndeux\n\ntrois'))
    expect(small.size).toBe(1)
  })

  it('ce que l agent connait apres une lecture partielle', () => {
    const before = snapshotOf('d', 'a\n\nb\n\nc\n\nd')
    const after = snapshotOf('d', 'a\n\nB\n\nc\n\nD')
    const merged = mergeSnapshot(before, after, 1, 1)
    expect(merged.blocks.map(b => b.hash)).toEqual([before.blocks[0]!.hash, after.blocks[1]!.hash, before.blocks[2]!.hash, before.blocks[3]!.hash])
    expect(merged.token).toBe('')
    expect(mergeSnapshot(before, after, 0, 3)).toBe(after)
  })
})

describe('patch_note', () => {
  it('inserer avant et apres un bloc, en une seule ecriture', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md', section: 'MCP' })
    const r = await tb.call('patch_note', {
      path: 'Plan.md',
      ops: [
        { op: 'insert_after', ref: refOf(NOTE, 'Le serveur MCP'), text: 'Il répond en JSON.' },
        { op: 'insert_before', ref: refOf(NOTE, '## Suite'), text: '## Sécurité\n\nUn jeton par agent.' },
      ],
      why: 'compléter',
    })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('Le serveur MCP parle aux IA.\n\nIl répond en JSON.\n\n### Bases')
    expect(host.content('Plan.md')).toContain('- deux lignes\n\n## Sécurité\n\nUn jeton par agent.\n\n## Suite')
    expect(host.batches).toHaveLength(1)
    expect(host.batches[0]!.changes).toHaveLength(2)
    // La trace, une fois ; les nouveaux blocs, avec leur reference, pour continuer sans relire.
    expect(host.review.filter(e => e.kind === 'edit').map(e => e.text)).toEqual(['2 retouches : compléter'])
    expect(r.result.text).toMatch(/Version : v[0-9a-f]{10}/)
    expect(r.result.text).toContain(`‹${refOf(host.content('Plan.md'), 'Il répond en JSON.')}› ligne 12`)
  })

  it('remplacer et supprimer un bloc ; le ^id du bloc remplace reste', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md' })
    const r = await tb.call('patch_note', {
      path: 'Plan.md',
      ops: [
        { op: 'replace', ref: '^intro', text: 'Nouvelle introduction.' },
        { op: 'delete', ref: refOf(NOTE, 'La suite du plan') },
      ],
    })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('# Plan\n\nNouvelle introduction. ^intro\n\n## MCP')
    expect(host.content('Plan.md')).toContain('## Suite\n\n### Bases')
  })

  it('dans un bloc : inserer, remplacer, supprimer autour d un court passage', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    const list = refOf(NOTE, '- une ligne')
    const r = await tb.call('patch_note', {
      path: 'Plan.md',
      ops: [
        { op: 'insert_after', ref: list, find: '- une ligne', text: '\n- une ligne et demie' },
        { op: 'replace', ref: list, find: 'deux', text: 'trois' },
        { op: 'delete', ref: '^intro', find: ' du plan' },
      ],
    })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('- une ligne\n- une ligne et demie\n- trois lignes')
    expect(host.content('Plan.md')).toContain('Introduction. ^intro')
    // Un passage absent du bloc : refuse, avec le texte du bloc.
    const miss = await tb.call('patch_note', { path: 'Plan.md', ops: [{ op: 'replace', ref: '^intro', find: 'absent', text: 'x' }] })
    expect(miss.result.isError).toBe(true)
    expect(miss.result.text).toContain('Passage introuvable dans le bloc ‹^intro›')
    expect(miss.result.text).toContain('Introduction. ^intro')
  })

  it('bloc change depuis la lecture : refuse, rend son texte d aujourd hui, la reprise passe', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md' })
    const stale = refOf(NOTE, 'Le serveur MCP')
    const n = host.notes.get(host.idOf('Plan.md'))!
    n.content = n.content.replace('Le serveur MCP parle aux IA.', 'Le serveur MCP parle à tout le monde.')
    const before = n.content
    const r = await tb.call('patch_note', { path: 'Plan.md', ops: [{ op: 'replace', ref: stale, text: 'Texte de l’IA.' }] })
    expect(r.result.isError).toBe(true)
    expect(r.result.text).toContain('Rien n’a été écrit')
    const fresh = refOf(before, 'Le serveur MCP')
    expect(r.result.text).toContain(`‹${fresh}›\nLe serveur MCP parle à tout le monde.`)
    expect(host.content('Plan.md')).toBe(before)
    expect(host.writes).toEqual([])
    const again = await tb.call('patch_note', { path: 'Plan.md', ops: [{ op: 'replace', ref: fresh, text: 'Texte de l’IA.' }] })
    expect(again.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('## MCP\n\nTexte de l’IA.\n\n### Bases')
  })

  it('bloc vise par son ^id : refuse s il a change depuis la lecture de l agent, puis la reprise passe', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md' })
    const n = host.notes.get(host.idOf('Plan.md'))!
    n.content = n.content.replace('Introduction du plan.', 'Introduction réécrite par Jean.')
    const op = { op: 'replace', ref: '^intro', text: 'Introduction de l’IA.' }
    const r = await tb.call('patch_note', { path: 'Plan.md', ops: [op] })
    expect(r.result.isError).toBe(true)
    expect(r.result.text).toContain('le bloc ‹^intro› a changé depuis votre lecture')
    expect(r.result.text).toContain('Introduction réécrite par Jean. ^intro')
    expect(host.content('Plan.md')).toContain('Introduction réécrite par Jean.')
    // Il a vu le texte d'aujourd'hui : la meme operation passe.
    expect((await tb.call('patch_note', { path: 'Plan.md', ops: [op] })).result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('Introduction de l’IA. ^intro')
    // Inserer a cote d'un bloc ^id ne depend pas de son texte.
    n.content = n.content.replace('Introduction de l’IA.', 'Encore changée.')
    expect((await tb.call('patch_note', { path: 'Plan.md', ops: [{ op: 'insert_after', ref: '^intro', text: 'Un ajout.' }] })).result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('Encore changée. ^intro\n\nUn ajout.\n\n## MCP')
  })

  it('reference inconnue : le dit ; deux operations sur le meme passage : refuse', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    const none = await tb.call('patch_note', { path: 'Plan.md', ops: [{ op: 'delete', ref: 'deadbeef' }] })
    expect(none.result.isError).toBe(true)
    expect(none.result.text).toContain('bloc ‹deadbeef› introuvable')
    const ref = refOf(NOTE, 'Le serveur MCP')
    const twice = await tb.call('patch_note', { path: 'Plan.md', ops: [{ op: 'replace', ref, text: 'a' }, { op: 'delete', ref }] })
    expect(twice.result.isError).toBe(true)
    expect(host.content('Plan.md')).toBe(NOTE)
  })

  it('mode proposition : une suggestion par retouche, la note ne change pas, pas deux fois la meme', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host, { mode: 'propose' })
    const ops = [
      { op: 'replace', ref: refOf(NOTE, 'Le serveur MCP'), find: 'aux IA', text: 'aux assistants' },
      { op: 'insert_after', ref: '^intro', text: 'Un ajout.' },
    ]
    const r = await tb.call('patch_note', { path: 'Plan.md', ops })
    expect(r.result.text).toContain('2 proposition(s) déposée(s)')
    expect(host.content('Plan.md')).toBe(NOTE)
    expect(host.writes).toEqual([])
    // Dans l'ordre du texte.
    expect(host.review.map(e => [e.kind, e.quote, e.replacement])).toEqual([
      ['suggestion', '', '\n\nUn ajout.'],
      ['suggestion', 'aux IA', 'aux assistants'],
    ])
    // Rejouee : la correction deja proposee ne revient pas.
    const again = await tb.call('patch_note', { path: 'Plan.md', ops: [ops[0]!] })
    expect(again.result.text).toContain('déjà dans la Révision')
    expect(host.review).toHaveLength(2)
  })

  it('la note bouge entre la lecture et l ecriture : recalcule une fois, sans rien abimer', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    host.beforeWrite = () => {
      const n = host.notes.get(host.idOf('Plan.md'))!
      n.content = `Un mot de Jean.\n\n${n.content}`
    }
    const r = await tb.call('patch_note', { path: 'Plan.md', ops: [{ op: 'replace', ref: refOf(NOTE, 'La suite du plan'), text: 'La suite, par l’IA.' }] })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Plan.md').startsWith('Un mot de Jean.\n\n---')).toBe(true)
    expect(host.content('Plan.md')).toContain('## Suite\n\nLa suite, par l’IA.\n\n### Bases')
  })

  it('sans applyChanges (ancien hote) : les changements partent de la fin vers le debut', async () => {
    const host = new MemoryHost({ 'Plan.md': NOTE })
    const r = await box(host).call('patch_note', {
      path: 'Plan.md',
      ops: [{ op: 'replace', ref: '^intro', find: 'Introduction', text: 'Préambule' }, { op: 'delete', ref: refOf(NOTE, 'La suite du plan') }],
    })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('Préambule du plan. ^intro')
    expect(host.content('Plan.md')).not.toContain('La suite du plan.')
    expect(host.writes).toHaveLength(2)
  })

  it('ce que l agent ecrit lui-meme ne lui est pas signale comme un changement', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md' })
    await tb.call('patch_note', { path: 'Plan.md', ops: [{ op: 'replace', ref: refOf(NOTE, 'La suite du plan'), text: 'La suite, par l’IA.' }] })
    const n = host.notes.get(host.idOf('Plan.md'))!
    n.content = n.content.replace('Le serveur MCP parle aux IA.', 'Le serveur MCP, revu par Jean.')
    const r = await tb.call('read_note', { path: 'Plan.md', since: 'last' })
    expect(r.result.text).toContain('1 bloc(s) modifié(s), 0 ajouté(s), 0 supprimé(s)')
    expect(r.result.text).toContain('Le serveur MCP, revu par Jean.')
    expect(r.result.text).not.toContain('La suite, par l’IA.')
  })

  it('edit_note accepte un passage recopie avec ses lignes de reference', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    const read = await tb.call('read_note', { path: 'Plan.md', section: 'Suite > Bases' })
    const copied = read.result.text.slice(read.result.text.indexOf('\n\n') + 2)
    expect(copied.startsWith('‹')).toBe(true)
    const r = await tb.call('edit_note', { path: 'Plan.md', find: copied, replace: '### Fin\n\nTerminé.' })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Plan.md').endsWith('La suite du plan.\n\n### Fin\n\nTerminé.')).toBe(true)
  })
})

describe('ancres', () => {
  const text = 'Un chat dort. Un chat mange. Un chien court.'

  it('la position relative resolue par l hote sert si le texte entre les deux est encore la citation', () => {
    const a = anchorOf('d', text, 17, 21, 's', 'e')
    expect(a).toMatchObject({ quote: 'chat', prefix: 'Un chat dort. Un ', suffix: ' mange. Un chien court.' })
    expect(resolveAnchor(text, a, { from: 17, to: 21 })).toEqual({ from: 17, to: 21 })
    // Positions resolues mais sur un autre texte : on cherche la citation.
    expect(resolveAnchor(text, a, { from: 3, to: 6 })).toEqual({ from: 17, to: 21 })
  })

  it('secours : la citation, et le contexte pour choisir la bonne occurrence', () => {
    const a = anchorOf('d', text, 17, 21, '', '')
    const moved = `Avant. ${text.replace('mange', 'mange bien')}`
    expect(locateAnchor(moved, a)).toEqual({ from: 24, to: 28 })
    // Plus de contexte pour trancher : ancre perdue.
    expect(locateAnchor('chat chat', { quote: 'chat', prefix: 'xx', suffix: 'yy' })).toBeNull()
    expect(locateAnchor('rien ici', a)).toBeNull()
  })

  it('un curseur : la ou le texte d avant et le texte d apres se suivent', () => {
    const a = anchorOf('d', text, 14, 14, '', '')
    expect(a.quote).toBe('')
    expect(locateAnchor(`Titre\n\n${text}`, a)).toEqual({ from: 21, to: 21 })
    expect(locateAnchor('tout autre texte', a)).toBeNull()
    expect(locateAnchor('', { quote: '', prefix: '', suffix: '' })).toEqual({ from: 0, to: 0 })
  })

  it('patch_note at : ecrit a l ancre, meme si la note a bouge ; ancre perdue sinon', async () => {
    const host = new FineHost({ 'Chats.md': text })
    const id = host.idOf('Chats.md')
    const tb = box(host)
    const anchor = anchorOf(id, text, 17, 21, 'rel-debut', 'rel-fin')
    // La note a bouge : l'hote resout les positions relatives.
    host.notes.get(id)!.content = `Avant. ${text}`
    host.relative.set('rel-debut', { from: 24, to: 28 })
    const r = await tb.call('patch_note', { ops: [{ op: 'replace', at: anchor, text: 'lion' }] })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Chats.md')).toBe('Avant. Un chat dort. Un lion mange. Un chien court.')
    // Un curseur : on insere a sa place.
    const cursor = anchorOf(id, host.content('Chats.md'), 6, 6, '', '')
    expect((await tb.call('patch_note', { id, ops: [{ op: 'insert_after', at: cursor, text: ' Encore.' }] })).result.isError).toBeFalsy()
    expect(host.content('Chats.md').startsWith('Avant. Encore. Un chat dort.')).toBe(true)
    // Le passage a disparu : ancre perdue, rien n'est ecrit.
    const before = host.content('Chats.md')
    const lost = await tb.call('patch_note', { id, ops: [{ op: 'replace', at: { ...anchor, quote: 'zèbre', start: 'x', end: 'x' }, text: 'y' }] })
    expect(lost.result.isError).toBe(true)
    expect(lost.result.text).toContain('ancre perdue')
    expect(host.content('Chats.md')).toBe(before)
    // Une ancre d'une autre note.
    expect((await tb.call('patch_note', { id, ops: [{ op: 'delete', at: { ...anchor, docId: 'autre' } }] })).result.isError).toBe(true)
  })
})

describe('effet de frappe', () => {
  const long = 'Voici un long paragraphe écrit par une IA, que les personnes qui ont la note ouverte doivent voir arriver petit à petit, mot après mot.'

  it('un texte se coupe en morceaux de quelques mots, qui recolles le redonnent', () => {
    const chunks = typingChunks(long, 40)
    expect(chunks.join('')).toBe(long)
    expect(chunks.length).toBeGreaterThan(4)
    expect(typingChunks(long, 4).length).toBeLessThanOrEqual(4)
    expect(typingChunks('court', 10)).toEqual(['court'])
  })

  it('le plan : une premiere ecriture, puis la suite du long texte a sa place', () => {
    const before = 'AAAA BBBB CCCC'
    const changes: TextChange[] = [{ from: 0, to: 4, text: 'aa' }, { from: 5, to: 5, text: long }, { from: 10, to: 14, text: 'cc' }]
    const plan = planTyping(changes, { budgetMs: 1000, maxWrites: 8 })
    expect(plan.first.map(c => [c.from, c.to])).toEqual([[0, 4], [5, 5], [10, 14]])
    expect(plan.tails).toHaveLength(1)
    // On rejoue : premiere ecriture, puis chaque morceau a la suite.
    let text = ''
    let at = 0
    for (const c of plan.first) { text += before.slice(at, c.from) + c.text; at = c.to }
    text += before.slice(at)
    let pos = plan.tails[0]!.at
    for (const chunk of plan.tails[0]!.chunks) { text = text.slice(0, pos) + chunk + text.slice(pos); pos += chunk.length }
    expect(text).toBe(`aa ${long}BBBB cc`)
    expect(plan.tails[0]!.chunks.length).toBeLessThanOrEqual(8)
    expect(plan.delayMs * plan.tails[0]!.chunks.length).toBeLessThanOrEqual(1000)
    // Un texte court part d'un coup.
    expect(planTyping([{ from: 0, to: 0, text: 'x'.repeat(TYPING_MIN_CHARS) }], { budgetMs: 1000, maxWrites: 8 }).tails).toEqual([])
  })

  it('les outils d ecriture demandent l effet de frappe a l hote', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    await box(host).call('append', { path: 'Plan.md', text: long })
    expect(host.batches).toEqual([{ changes: [{ from: NOTE.length, to: NOTE.length, text: `\n\n${long}` }], typing: true }])
    expect(host.review.filter(e => e.kind === 'edit')).toHaveLength(1)
  })
})

describe('presence', () => {
  it('lire : reading (avec la partie lue), puis idle', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    await tb.call('read_note', { path: 'Plan.md' })
    expect(host.signals).toEqual(['reading', 'idle'])
    host.signals = []
    await tb.call('read_note', { path: 'Plan.md', section: 'Suite > Bases' })
    expect(host.signals).toEqual([`reading ${NOTE.lastIndexOf('### Bases')}-${NOTE.length}`, 'idle'])
  })

  it('ecrire : writing avec la plage ecrite, puis idle, meme si l ecriture echoue', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    const tb = box(host)
    const at = NOTE.indexOf('La suite du plan.')
    await tb.call('edit_note', { path: 'Plan.md', find: 'La suite du plan.', replace: 'Fin.' })
    expect(host.signals).toEqual([`writing ${at}-${at + 4}`, 'idle'])
    host.signals = []
    host.applyChanges = async () => { throw new HostError('refusé', 'denied') }
    const r = await tb.call('append', { path: 'Plan.md', text: 'x' })
    expect(r.result.isError).toBe(true)
    expect(host.signals.at(-1)).toBe('idle')
  })

  it('un hote dont la presence echoue ne fait pas echouer l outil', async () => {
    const host = new FineHost({ 'Plan.md': NOTE })
    host.signal = () => { throw new Error('pas de présence') }
    expect((await box(host).call('read_note', { path: 'Plan.md' })).result.isError).toBeFalsy()
  })
})
