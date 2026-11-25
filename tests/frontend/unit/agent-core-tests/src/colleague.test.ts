// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'IA comme un collegue, sans se sentir observe :
//  - une demande par selection + commentaire (« Demander à… », « @Nom »),
//    traitee une seule fois, dans son fil et dans son passage ;
//  - des commentaires d'agent peu nombreux et courts ;
//  - jamais d'ecriture dans le paragraphe ou la personne tape.
import { describe, it, expect, vi } from 'vitest'
import {
  BlockWatcher, EditorContextRing, HostError, MAX_AGENT_COMMENT_CHARS, MAX_NEW_COMMENTS, NEW_COMMENTS_WINDOW_MS, TYPING_GUARD_MS, ToolBox,
  buildEditorContext, clipComment, confineHost, coreCatalog, findAgentMention, guardTyping, parseTypingSpot, refBlocks, requestAgent, requestLine,
  requestPrompt, resolveAsk, touchesTyping, typingRefusal, typingZone,
  type HostRequest, type TextChange, type TypingSpot, type WatchMemory, type WatchMemoryStore, type WatchNote,
} from '@savoire/agent-core'
import { changeNoteText, splitNoteBlocks, textFingerprint, type AIChatRequest, type AIChatResponse, type AgentDefinition, type PluginTool, type ToolActor } from '@savoire/plugin-api'
import { MemoryHost } from './memoryHost'

const actor: ToolActor = { agentId: 'a1', agentName: 'Relecteur', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }
const NOW = Date.parse('2026-11-25T10:00:00Z')

function agent(p: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'a1', name: 'Relecteur', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct', comment: 'direct', edit: 'direct' }, ...p }
}

const NOTE = ['# Plan', '', 'Premier paragraphe du plan.', '', 'Second paragraphe, plus loin.', '', '- une ligne', '- deux lignes'].join('\n')
const at = (text: string, needle: string): number => text.indexOf(needle)

/** Un hote qui sait ou la personne tape, qui ecrit par lots, et qui tient des demandes. */
class Host extends MemoryHost {
  spot: TypingSpot | null = null
  /** Positions relatives « resolues » (test) : start -> position. */
  relative = new Map<string, number>()
  requests: (HostRequest & { agentId: string; state: string })[] = []
  now = NOW

  async typing(docId: string): Promise<TypingSpot | null> {
    return this.spot?.docId === docId ? this.spot : null
  }

  async resolveRelative(_docId: string, start: string): Promise<{ from: number; to: number } | null> {
    const p = this.relative.get(start)
    return p === undefined ? null : { from: p, to: p }
  }

  async applyChanges(docId: string, changes: readonly TextChange[], _actor: ToolActor, opts: { expect?: string } = {}): Promise<void> {
    const n = this.notes.get(docId)!
    if (opts.expect !== undefined && textFingerprint(n.content) !== opts.expect) throw new HostError('La note a changé pendant la modification : relisez-la.', 'conflict')
    let out = ''
    let last = 0
    for (const c of changes) { out += n.content.slice(last, c.from) + c.text; last = c.to }
    n.content = out + n.content.slice(last)
    this.writes.push(`patch ${n.path}`)
  }

  /** Les entrees de l'agent portent son id, et l'heure du test. */
  private tag(id: string, who: ToolActor): string {
    const e = this.review.find(x => x.id === id)!
    e.authorAgentId = who.agentId
    e.createdAt = new Date(this.now).toISOString()
    return id
  }

  override async comment(docId: string, text: string, who: ToolActor, range?: { from: number; to: number }): Promise<string> {
    return this.tag(await super.comment(docId, text, who, range), who)
  }

  override async reply(rootId: string, text: string, who: ToolActor): Promise<string> {
    return this.tag(await super.reply(rootId, text, who), who)
  }

  async listRequests(agentId: string): Promise<HostRequest[]> {
    return this.requests.filter(r => r.agentId === agentId && r.state === 'open').map(({ agentId: _a, state: _s, ...r }) => r)
  }

  async closeRequest(rootId: string, who: ToolActor): Promise<boolean> {
    const r = this.requests.find(x => x.id === rootId && x.agentId === who.agentId && x.state === 'open')
    if (r) r.state = 'done'
    return !!r
  }

  /** La personne tape a la fin de ce paragraphe, il y a `ageMs`. */
  typeIn(path: string, paragraph: string, ageMs = 1000): void {
    const content = this.content(path)
    const pos = at(content, paragraph) + paragraph.length
    this.relative.set('cur', pos)
    this.spot = { docId: this.idOf(path), ageMs, blockHash: refBlocks(content).find(b => b.text.startsWith(paragraph))!.hash, anchor: { start: 'cur', end: 'cur', prefix: content.slice(pos - 12, pos), suffix: content.slice(pos, pos + 12) } }
  }
}

function box(host: Host, opts: { a?: AgentDefinition; mode?: 'propose'; approve?: () => Promise<'approved' | 'refused'>; pluginTools?: PluginTool[]; who?: ToolActor } = {}): ToolBox {
  return new ToolBox({
    agent: opts.a ?? agent(), person: { canWrite: true }, actor: opts.who ?? actor, runtime: 'app', host, now: () => host.now,
    ...(opts.mode ? { imposedMode: opts.mode } : {}), ...(opts.approve ? { approve: opts.approve } : {}), ...(opts.pluginTools ? { pluginTools: opts.pluginTools } : {}),
  })
}

// ── 3. Jamais dans le paragraphe ou la personne tape ───────────────────────

describe('le paragraphe ou la personne tape', () => {
  it('se retrouve par le curseur, sinon par le texte autour, sinon par son empreinte', () => {
    const blocks = refBlocks(NOTE)
    const second = blocks.find(b => b.text.startsWith('Second'))!
    const end = second.end
    // Curseur resolu par l'hote : le bloc qui le contient (sa fin comprise).
    expect(typingZone(NOTE, { docId: 'd', ageMs: 0 }, { from: end, to: end })).toEqual({ from: second.from, to: second.end, cursor: end })
    // Sans position relative : le texte juste avant et juste apres le curseur.
    const mid = second.from + 6
    expect(typingZone(NOTE, { docId: 'd', ageMs: 0, anchor: { prefix: NOTE.slice(mid - 8, mid), suffix: NOTE.slice(mid, mid + 8) } }))
      .toEqual({ from: second.from, to: second.end, cursor: mid })
    // Sinon l'empreinte du bloc (pas de curseur connu).
    expect(typingZone(NOTE, { docId: 'd', ageMs: 0, blockHash: second.hash })).toEqual({ from: second.from, to: second.end })
    // Le bloc a change et rien ne le designe : on ne sait plus.
    expect(typingZone(NOTE, { docId: 'd', ageMs: 0, blockHash: 'ffffffff' })).toBeNull()
    // Entre deux blocs (un paragraphe qu'elle commence) : le curseur seul.
    const text = `${NOTE}\n\n`
    expect(typingZone(text, { docId: 'd', ageMs: 0 }, { from: text.length, to: text.length })).toEqual({ from: text.length, to: text.length, cursor: text.length })
  })

  it('une retouche le touche si elle le recouvre, s y insere, ou tombe sur le curseur', () => {
    const zone = { from: 10, to: 30, cursor: 30 }
    expect(touchesTyping({ from: 12, to: 15, text: 'x' }, zone)).toBe(true)
    expect(touchesTyping({ from: 0, to: 11, text: '' }, zone)).toBe(true)
    expect(touchesTyping({ from: 20, to: 20, text: 'x' }, zone)).toBe(true)
    // A sa fin : la ou l'on tape le plus souvent.
    expect(touchesTyping({ from: 30, to: 30, text: '\n\nsuite' }, zone)).toBe(true)
    // Juste avant le bloc, ou un autre bloc : non.
    expect(touchesTyping({ from: 10, to: 10, text: 'avant\n\n' }, zone)).toBe(false)
    expect(touchesTyping({ from: 0, to: 10, text: '' }, zone)).toBe(false)
    expect(touchesTyping({ from: 32, to: 40, text: 'x' }, zone)).toBe(false)
    // Curseur au tout debut du bloc : une insertion a cet endroit le touche.
    expect(touchesTyping({ from: 10, to: 10, text: 'x' }, { from: 10, to: 30, cursor: 10 })).toBe(true)
  })

  it('patch_note, edit_note et append refusent d ecrire la ou elle tape, et ecrivent ailleurs', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    host.typeIn('Plan.md', 'Second paragraphe, plus loin.')
    const tools = box(host)
    const second = refBlocks(NOTE).find(b => b.text.startsWith('Second'))!.ref
    const first = refBlocks(NOTE).find(b => b.text.startsWith('Premier'))!.ref

    const patch = await tools.call('patch_note', { path: 'Plan.md', ops: [{ op: 'replace', ref: second, text: 'Réécrit par l’IA.' }] })
    expect(patch.result.isError).toBe(true)
    expect(patch.result.text).toContain('La personne écrit dans ce paragraphe en ce moment')
    expect(patch.result.text).toContain('propose: true')
    const edit = await tools.call('edit_note', { path: 'Plan.md', find: 'plus loin', replace: 'ailleurs' })
    expect(edit.result.text).toContain(typingRefusal('propose: true'))
    // Inserer juste apres son paragraphe, c'est encore sous son curseur.
    const after = await tools.call('patch_note', { path: 'Plan.md', ops: [{ op: 'insert_after', ref: second, text: 'Un ajout.' }] })
    expect(after.result.isError).toBe(true)
    expect(host.content('Plan.md')).toBe(NOTE)
    expect(host.review).toEqual([])

    // Un autre paragraphe : l'agent ecrit.
    const elsewhere = await tools.call('patch_note', { path: 'Plan.md', ops: [{ op: 'replace', ref: first, text: 'Premier paragraphe, retouché.' }] })
    expect(elsewhere.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('Premier paragraphe, retouché.')

    // Elle tape a la fin de la note : append attend aussi.
    const tail = new Host({ 'Fin.md': 'Un seul paragraphe' })
    tail.typeIn('Fin.md', 'Un seul paragraphe')
    const append = await box(tail).call('append', { path: 'Fin.md', text: 'Suite de l’IA.' })
    expect(append.result.isError).toBe(true)
    expect(tail.content('Fin.md')).toBe('Un seul paragraphe')
  })

  it('apres 8 s sans frappe, l agent ecrit', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    host.typeIn('Plan.md', 'Second paragraphe, plus loin.', TYPING_GUARD_MS)
    const r = await box(host).call('edit_note', { path: 'Plan.md', find: 'plus loin', replace: 'ailleurs' })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('Second paragraphe, ailleurs.')
  })

  it('propose: true depose une proposition au lieu d ecrire, meme pour un agent en ecriture directe', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    host.typeIn('Plan.md', 'Second paragraphe, plus loin.')
    const r = await box(host).call('edit_note', { path: 'Plan.md', find: 'plus loin', replace: 'ailleurs', propose: true })
    expect(r.result.isError).toBeFalsy()
    expect(r.result.text).toContain('Proposition déposée')
    expect(host.content('Plan.md')).toBe(NOTE)
    expect(host.review).toMatchObject([{ kind: 'suggestion', quote: 'plus loin', replacement: 'ailleurs' }])
    // Les trois outils d'ecriture l'offrent.
    const specs = coreCatalog('server')
    for (const name of ['edit_note', 'patch_note', 'append']) expect(specs.find(s => s.name === name)!.inputSchema.properties.propose?.type).toBe('boolean')
  })

  it('un agent en mode proposition n est pas gene : il n ecrit pas', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    host.typeIn('Plan.md', 'Second paragraphe, plus loin.')
    const r = await box(host, { mode: 'propose' }).call('edit_note', { path: 'Plan.md', find: 'plus loin', replace: 'ailleurs' })
    expect(r.result.isError).toBeFalsy()
    expect(host.review).toHaveLength(1)
  })

  it('une ecriture que la personne vient d accepter passe, meme la ou elle tapait', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    host.typeIn('Plan.md', 'Second paragraphe, plus loin.')
    const a = agent({ permissions: { read: 'direct', edit: 'ask' } })
    const r = await box(host, { a, approve: async () => 'approved' }).call('edit_note', { path: 'Plan.md', find: 'plus loin', replace: 'ailleurs' })
    expect(r.approval).toBe('approved')
    expect(r.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('Second paragraphe, ailleurs.')
  })

  it('un hote qui ne sait pas, ou qui echoue, ne bloque rien', async () => {
    await expect(guardTyping({}, 'd', NOTE, [{ from: 0, to: 1, text: 'x' }])).resolves.toBeUndefined()
    await expect(guardTyping({ typing: async () => { throw new Error('panne') } }, 'd', NOTE, [{ from: 0, to: 1, text: 'x' }])).resolves.toBeUndefined()
    // Une frappe dans une autre note ne compte pas.
    await expect(guardTyping({ typing: async () => ({ docId: 'autre', ageMs: 0, blockHash: refBlocks(NOTE)[0]!.hash }) }, 'd', NOTE, [{ from: 0, to: 1, text: 'x' }])).resolves.toBeUndefined()
    await expect(guardTyping({ typing: async () => ({ docId: 'd', ageMs: 0, blockHash: refBlocks(NOTE)[0]!.hash }) }, 'd', NOTE, [{ from: 0, to: 1, text: 'x' }]))
      .rejects.toMatchObject({ code: 'busy' })
  })

  it('les outils de texte des plugins (changeNoteText) obeissent a la meme regle', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    const id = host.idOf('Plan.md')
    const api = {
      vault: {
        read: async () => host.content('Plan.md'),
        editText: async (_doc: string, edit: (s: string) => string) => { host.notes.get(id)!.content = edit(host.content('Plan.md')); return true },
      },
    } as never
    const tool: PluginTool = {
      spec: { name: 'demo_replace', title: 'Remplacer', description: '', action: 'edit', inputSchema: { type: 'object', properties: {} } },
      run: async (args, ctx) => ({ text: await changeNoteText(api, ctx, id, md => md.replace(String(args.find), String(args.to)), 'remplacer') }),
    }
    host.typeIn('Plan.md', 'Second paragraphe, plus loin.')
    const tools = box(host, { pluginTools: [tool] })
    const refused = await tools.call('demo_replace', { find: 'plus loin', to: 'ailleurs' })
    expect(refused.result.isError).toBe(true)
    expect(refused.result.text).toContain('La personne écrit dans ce paragraphe')
    expect(host.content('Plan.md')).toBe(NOTE)
    const ok = await tools.call('demo_replace', { find: 'Premier', to: 'Tout premier' })
    expect(ok.result.text).toBe('done')
    expect(host.content('Plan.md')).toContain('Tout premier paragraphe')
  })

  it('ce que le serveur joint a tools.call se lit, borne', () => {
    expect(parseTypingSpot({ docId: 'd', ageMs: 1200, blockHash: 'abcd', anchor: { start: 'AAE=', end: 'AAE=', prefix: 'avant', suffix: 'apres', quote: 'ignore' } }))
      .toEqual({ docId: 'd', ageMs: 1200, blockHash: 'abcd', anchor: { start: 'AAE=', end: 'AAE=', prefix: 'avant', suffix: 'apres' } })
    expect(parseTypingSpot(null)).toBeNull()
    expect(parseTypingSpot({ docId: 'd' })).toBeNull()
    expect(parseTypingSpot({ docId: '', ageMs: 1 })).toBeNull()
  })

  it('l entree de contexte porte l heure de la frappe, et la memoire retrouve la derniere', () => {
    const base = { vaultId: 'v', docId: 'd', path: 'Plan.md', text: NOTE, from: 5, to: 5, tabId: 't', encode: (i: number) => `p${i}` }
    const ring = new EditorContextRing()
    expect(ring.lastTyped()).toBeNull()
    ring.push(buildEditorContext({ ...base, at: 1000 }))
    expect(ring.lastTyped()).toBeNull()
    ring.push(buildEditorContext({ ...base, from: 20, to: 20, at: 2000, typingAt: 1900 }))
    // Elle clique ailleurs sans taper : la derniere frappe reste celle d'avant.
    ring.push(buildEditorContext({ ...base, from: 40, to: 40, at: 3000 }))
    expect(ring.last()!.typingAt).toBeUndefined()
    expect(ring.lastTyped()).toMatchObject({ typingAt: 1900, anchor: { start: 'p20' } })
  })
})

// ── La veille obeit a la meme regle ────────────────────────────────────────

class Memories implements WatchMemoryStore {
  load(): WatchMemory { return { seen: new Map(), remarks: [] } }
  save(): void { /* rien a garder ici */ }
}

describe('la veille et la frappe', () => {
  it('ne relit pas le paragraphe ou la personne tape ; elle y revient quand elle a fini', async () => {
    vi.useFakeTimers()
    try {
      const text = 'Un premier paragraphe.\n\nCelui qu’elle écrit.'
      const note: WatchNote = { vaultId: 'v', docId: 'n1', path: 'Note.md', text, blocks: splitNoteBlocks(text) }
      const typed = note.blocks[1]!
      let typing: { blockHash: string; freeInMs: number } | null = { blockHash: typed.hash, freeInMs: 6000 }
      const calls: { req: AIChatRequest; resolve: (t: string) => void }[] = []
      const chat = (req: AIChatRequest): Promise<AIChatResponse> => new Promise(resolve => {
        calls.push({ req, resolve: t => resolve({ text: t, model: 'm', connection: 'c', usage: { inputTokens: 1, outputTokens: 1 } }) })
      })
      const read = (i: number): string => { const c = calls[i]!.req.messages[1]!.content; return c.slice(c.lastIndexOf('<<<\n') + 4, c.lastIndexOf('\n>>>')) }
      const w = new BlockWatcher({ agent: agent({ watch: {} }), chat, memory: new Memories(), onFinding: () => {}, typing: () => typing })
      w.update(note)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls).toHaveLength(1)
      expect(read(0)).toBe('Un premier paragraphe.')
      calls[0]!.resolve('{"fautes":[],"conseil":null,"resume":"un"}')
      await vi.advanceTimersByTimeAsync(0)
      // Le paragraphe en cours d'ecriture attend.
      expect(calls).toHaveLength(1)
      expect(w.status().pending).toBe(1)
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls).toHaveLength(1)
      // Elle a fini : il est relu.
      typing = null
      await vi.advanceTimersByTimeAsync(1100)
      expect(calls).toHaveLength(2)
      expect(read(1)).toBe('Celui qu’elle écrit.')
      w.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── 2. Peu de commentaires, et courts ──────────────────────────────────────

describe('commentaires d agent : peu et courts', () => {
  it('un commentaire ou une reponse trop longs sont refuses, avec la limite', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    const tools = box(host)
    const long = 'mot '.repeat(120).trim()
    const r = await tools.call('comment', { path: 'Plan.md', text: long, quote: 'Premier paragraphe' })
    expect(r.result.isError).toBe(true)
    expect(r.result.text).toContain(`${MAX_AGENT_COMMENT_CHARS} au plus`)
    expect(host.review).toEqual([])
    const ok = await tools.call('comment', { path: 'Plan.md', text: 'x'.repeat(MAX_AGENT_COMMENT_CHARS), quote: 'Premier paragraphe' })
    expect(ok.result.isError).toBeFalsy()
    const reply = await tools.call('reply', { thread: (ok.result.data as { id: string }).id, text: long })
    expect(reply.result.isError).toBe(true)
    expect(reply.result.text).toContain('Commentaire trop long')
    expect(host.review).toHaveLength(1)
  })

  it('trois nouveaux commentaires au plus a la suite sur une note', async () => {
    const host = new Host({ 'Plan.md': NOTE, 'Autre.md': 'Autre note.' })
    const tools = box(host)
    for (let i = 0; i < MAX_NEW_COMMENTS; i++) {
      expect((await tools.call('comment', { path: 'Plan.md', text: `Remarque ${i + 1}.` })).result.isError).toBeFalsy()
    }
    const fourth = await tools.call('comment', { path: 'Plan.md', text: 'Encore une.' })
    expect(fourth.result.isError).toBe(true)
    expect(fourth.result.text).toContain(`${MAX_NEW_COMMENTS} au plus à la suite`)
    expect(host.review).toHaveLength(MAX_NEW_COMMENTS)
    // Une autre note, ou un autre agent : chacun son compte.
    expect((await tools.call('comment', { path: 'Autre.md', text: 'Ici, oui.' })).result.isError).toBeFalsy()
    const other: ToolActor = { ...actor, agentId: 'a2', agentName: 'Archiviste' }
    expect((await box(host, { who: other, a: agent({ id: 'a2', name: 'Archiviste' }) }).call('comment', { path: 'Plan.md', text: 'Moi aussi.' })).result.isError).toBeFalsy()
    // Répondre dans un fil existant reste permis.
    expect((await tools.call('reply', { thread: host.review[0]!.id, text: 'Précision.' })).result.isError).toBeFalsy()
  })

  it('la personne a repondu, resolu, ou du temps a passe : l agent peut commenter de nouveau', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    const tools = box(host)
    for (let i = 0; i < MAX_NEW_COMMENTS; i++) await tools.call('comment', { path: 'Plan.md', text: `Remarque ${i + 1}.` })
    expect((await tools.call('comment', { path: 'Plan.md', text: 'Refusée.' })).result.isError).toBe(true)
    // Elle repond a l'un des fils.
    host.review.push({ id: 'p1', docId: host.idOf('Plan.md'), kind: 'comment', text: 'Vu.', author: 'Jean', authorIsAgent: false, createdAt: new Date(NOW).toISOString(), parentId: host.review[0]!.id })
    expect((await tools.call('comment', { path: 'Plan.md', text: 'Quatrième.' })).result.isError).toBeFalsy()
    expect((await tools.call('comment', { path: 'Plan.md', text: 'Refusée.' })).result.isError).toBe(true)
    // Elle en resout un.
    host.review[1]!.status = 'resolved'
    expect((await tools.call('comment', { path: 'Plan.md', text: 'Cinquième.' })).result.isError).toBeFalsy()
    // Plus tard, le compte repart.
    host.now = NOW + NEW_COMMENTS_WINDOW_MS + 1000
    expect((await tools.call('comment', { path: 'Plan.md', text: 'Plus tard.' })).result.isError).toBeFalsy()
  })

  it('les fiches disent a l IA de preferer un commentaire court dans la marge', () => {
    const specs = coreCatalog('server')
    const comment = specs.find(s => s.name === 'comment')!
    expect(comment.description).toContain('UN commentaire court')
    expect(comment.description).toContain('marge')
    expect(comment.description).toContain(`${MAX_AGENT_COMMENT_CHARS} caractères`)
    expect(comment.description).toContain(`${MAX_NEW_COMMENTS} nouveaux commentaires au plus`)
    expect(specs.find(s => s.name === 'reply')!.description).toContain('une ou deux phrases')
  })

  it('une reponse trop longue est coupee a la fin d une phrase', () => {
    expect(clipComment('  Court.  ')).toBe('Court.')
    const long = `${'Une phrase assez longue pour compter. '.repeat(12)}Fin.`
    const cut = clipComment(long)
    expect(cut.length).toBeLessThanOrEqual(MAX_AGENT_COMMENT_CHARS + 1)
    expect(cut.endsWith('compter. …')).toBe(true)
    // Sans phrase : coupee a un mot.
    const words = clipComment('mot '.repeat(200))
    expect(words.length).toBeLessThanOrEqual(MAX_AGENT_COMMENT_CHARS)
    expect(words.endsWith('mot…')).toBe(true)
  })
})

// ── 1. Demander par selection + commentaire ────────────────────────────────

const AGENTS = [{ id: 'a1', name: 'Relecteur' }, { id: 'a2', name: 'Relecteur attentif' }, { id: 'a3', name: 'Archiviste' }, { id: 'a4', name: 'Élodie' }]

describe('a qui le commentaire est adresse', () => {
  it('« @Nom » designe un agent declare : nom entier d abord, casse et accents ignores', () => {
    expect(findAgentMention('@Archiviste range ça', AGENTS)?.id).toBe('a3')
    expect(findAgentMention('Peux-tu vérifier, @archiviste ?', AGENTS)?.id).toBe('a3')
    expect(findAgentMention('@relecteur attentif : reformule', AGENTS)?.id).toBe('a2')
    expect(findAgentMention('@Relecteur, reformule', AGENTS)?.id).toBe('a1')
    expect(findAgentMention('@elodie plus court', AGENTS)?.id).toBe('a4')
    // Le premier mot suffit s'il ne designe qu'un agent.
    expect(findAgentMention('@Archi non', AGENTS)).toBeNull()
    expect(findAgentMention('@Relecteur', [AGENTS[1]!, AGENTS[2]!])?.id).toBe('a2')
    // Ni une adresse, ni un inconnu, ni un nom plus long.
    expect(findAgentMention('écrire à jean@archiviste.fr', AGENTS)).toBeNull()
    expect(findAgentMention('@Inconnu fais ça', AGENTS)).toBeNull()
    expect(findAgentMention('@Archivistes', AGENTS)).toBeNull()
    expect(findAgentMention('un simple commentaire', AGENTS)).toBeNull()
  })

  it('« Demander à… » l emporte sur le texte ; sans IA dans l appli, la demande attend une IA externe', () => {
    expect(resolveAsk('reformule', AGENTS, 'app:a3', true)).toEqual({ agent: AGENTS[2], via: 'app' })
    expect(resolveAsk('@Relecteur reformule', AGENTS, 'external:a3', true)).toEqual({ agent: AGENTS[2], via: 'external' })
    expect(resolveAsk('@Relecteur reformule', AGENTS, '', true)).toEqual({ agent: AGENTS[0], via: 'app' })
    expect(resolveAsk('@Relecteur reformule', AGENTS, '', false)).toEqual({ agent: AGENTS[0], via: 'external' })
    expect(resolveAsk('reformule', AGENTS, 'app:a3', false)).toEqual({ agent: AGENTS[2], via: 'external' })
    // Personne : un simple commentaire.
    expect(resolveAsk('à revoir', AGENTS, '', true)).toBeNull()
    expect(resolveAsk('à revoir', AGENTS, 'app:supprime', true)).toBeNull()
  })

  it('l etat d une demande se dit en une ligne', () => {
    expect(requestLine({ agentName: 'Relecteur', state: 'running' })).toBe('Demande à Relecteur : il y travaille…')
    expect(requestLine({ agentName: 'Relecteur', state: 'running' }, true)).toBe('Demande à Relecteur : interrompue.')
    expect(requestLine({ agentName: 'ChatGPT', state: 'open' })).toContain('en attente de son IA')
    expect(requestLine({ agentName: 'Relecteur', state: 'done' })).toBe('Demande à Relecteur : répondue.')
    expect(requestLine({ agentName: 'Relecteur', state: 'failed', error: 'Aucune IA configurée' })).toBe('Demande à Relecteur : échec (Aucune IA configurée).')
  })
})

describe('un agent de l appli sur une demande', () => {
  it('ses droits : lire, ecrire dans le passage selon son mode, rien d autre', () => {
    const a = requestAgent(agent({ permissions: { read: 'direct', comment: 'direct', edit: 'ask', create: 'direct', organize: 'direct', delete: 'ask', delegate: 'direct', plugin: 'direct' }, delegates: ['x'] }))
    // « Demander » devient « proposer » : la proposition s'accepte sur le passage.
    expect(a.permissions).toEqual({ read: 'direct', edit: 'propose', comment: 'deny', create: 'deny', organize: 'deny', delete: 'deny', plugin: 'deny', delegate: 'deny' })
    expect(a.delegates).toEqual([])
    expect(a.canRequestMode).toBe(false)
    expect(requestAgent(agent({ permissions: { read: 'direct', edit: 'direct' } })).permissions.edit).toBe('direct')
    expect(requestAgent(agent({ permissions: { read: 'direct' } })).permissions.edit).toBe('deny')
    // Les outils offerts a l'IA : pas de commentaire, pas de creation, pas de corbeille.
    const names = new ToolBox({ agent: a, person: { canWrite: true }, actor, runtime: 'app', host: new Host() }).specs().map(s => s.name)
    expect(names).toEqual(expect.arrayContaining(['read_note', 'search', 'edit_note', 'patch_note']))
    for (const n of ['comment', 'reply', 'create_note', 'move_note', 'trash_note', 'request_mode']) expect(names).not.toContain(n)
  })

  it('il n ecrit que dans le passage de la demande', async () => {
    const host = new Host({ 'Plan.md': NOTE, 'Autre.md': 'Autre note.' })
    const docId = host.idOf('Plan.md')
    const quote = 'Second paragraphe, plus loin.'
    const confined = confineHost(host, { docId, passage: async () => { const i = host.content('Plan.md').indexOf('Second paragraphe'); return i < 0 ? null : { from: i, to: i + quote.length } } })
    const tools = new ToolBox({ agent: requestAgent(agent()), person: { canWrite: true }, actor, runtime: 'app', host: confined })

    // Hors du passage, dans la meme note ou ailleurs : refuse, rien ne change.
    const outside = await tools.call('edit_note', { path: 'Plan.md', find: 'Premier paragraphe', replace: 'Autre chose' })
    expect(outside.result.isError).toBe(true)
    expect(outside.result.text).toContain('vous n’écrivez que dans ce passage')
    const elsewhere = await tools.call('append', { path: 'Autre.md', text: 'Ajout.' })
    expect(elsewhere.result.isError).toBe(true)
    const end = await tools.call('append', { path: 'Plan.md', text: 'Ajout.' })
    expect(end.result.isError).toBe(true)
    expect(host.content('Plan.md')).toBe(NOTE)
    expect(host.content('Autre.md')).toBe('Autre note.')

    // Dans le passage : ecrit. Puis une seconde retouche, dans le passage tel qu'il est devenu.
    const inside = await tools.call('edit_note', { path: 'Plan.md', find: 'plus loin', replace: 'un peu plus loin encore' })
    expect(inside.result.isError).toBeFalsy()
    const again = await tools.call('edit_note', { path: 'Plan.md', find: 'encore.', replace: 'encore !' })
    expect(again.result.isError).toBeFalsy()
    expect(host.content('Plan.md')).toContain('Second paragraphe, un peu plus loin encore !')
    // Lire reste permis partout.
    expect((await tools.call('read_note', { path: 'Autre.md' })).result.text).toContain('Autre note.')
  })

  it('en mode proposition, ses suggestions restent dans le passage ; le reste de l hote est ferme', async () => {
    const host = new Host({ 'Plan.md': NOTE })
    const docId = host.idOf('Plan.md')
    const from = NOTE.indexOf('Second paragraphe')
    const confined = confineHost(host, { docId, passage: async () => ({ from, to: from + 'Second paragraphe, plus loin.'.length }) })
    const tools = new ToolBox({ agent: requestAgent(agent({ permissions: { read: 'direct', edit: 'ask' } })), person: { canWrite: true }, actor, runtime: 'app', host: confined })
    expect((await tools.call('edit_note', { path: 'Plan.md', find: 'Premier paragraphe', replace: 'x' })).result.isError).toBe(true)
    const ok = await tools.call('edit_note', { path: 'Plan.md', find: 'plus loin', replace: 'ailleurs' })
    expect(ok.result.text).toContain('Proposition déposée')
    expect(host.review).toMatchObject([{ kind: 'suggestion', quote: 'plus loin', replacement: 'ailleurs' }])
    expect(host.content('Plan.md')).toBe(NOTE)
    await expect(confined.comment(docId, 'x', actor)).rejects.toMatchObject({ code: 'denied' })
    await expect(confined.reply('r-1', 'x', actor)).rejects.toMatchObject({ code: 'denied' })
    await expect(confined.createNote('N.md', '', actor)).rejects.toMatchObject({ code: 'denied' })
    await expect(confined.trashNote(docId, actor)).rejects.toMatchObject({ code: 'denied' })
    // Le passage a disparu : plus rien ne s'ecrit.
    const gone = confineHost(host, { docId, passage: async () => null })
    await expect(gone.replaceText(docId, 0, 1, 'x', actor)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('la consigne dit le passage, la demande, et une reponse courte dans le fil', () => {
    const p = requestPrompt({ path: 'Plan.md', docId: 'd1', quote: 'Second paragraphe, plus loin.', text: '@Relecteur reformule plus court', author: 'Jean', writes: 'propose' })
    expect(p).toContain('<<<\nSecond paragraphe, plus loin.\n>>>')
    expect(p).toContain('Sa demande : @Relecteur reformule plus court')
    expect(p).toContain('propose la modification de ce passage seulement')
    expect(p).toContain(`${MAX_AGENT_COMMENT_CHARS} caractères au plus`)
    const follow = requestPrompt({ path: 'Plan.md', docId: 'd1', quote: '', text: 'plus formel', author: 'Jean', thread: [{ author: 'Jean', text: 'reformule' }, { author: 'Relecteur (IA), pour Jean', text: 'Quel ton ?' }] })
    expect(follow).toContain('- Relecteur (IA), pour Jean : Quel ton ?')
    expect(follow).toContain('Tu ne modifies rien')
  })
})

describe('une IA externe et les demandes', () => {
  it('list_requests rend les demandes ouvertes de l agent ; y repondre les clot, une seule fois', async () => {
    const host = new Host({ 'Plan.md': NOTE, 'Prive/Secret.md': 'x' })
    const docId = host.idOf('Plan.md')
    host.review.push({ id: 't1', docId, kind: 'comment', text: '@Relecteur reformule', author: 'Jean', authorIsAgent: false, createdAt: new Date(NOW).toISOString(), status: 'open', quote: 'Second paragraphe, plus loin.' })
    host.requests = [
      { id: 't1', docId, path: 'Plan.md', text: '@Relecteur reformule', quote: 'Second paragraphe, plus loin.', author: 'Jean', createdAt: new Date(NOW).toISOString(), agentId: 'a1', state: 'open' },
      { id: 't2', docId, path: 'Plan.md', text: 'pour un autre', quote: '', author: 'Jean', createdAt: new Date(NOW).toISOString(), agentId: 'a2', state: 'open' },
      { id: 't3', docId: host.idOf('Prive/Secret.md'), path: 'Prive/Secret.md', text: 'hors portée', quote: '', author: 'Jean', createdAt: new Date(NOW).toISOString(), agentId: 'a1', state: 'open' },
    ]
    const tools = box(host, { a: agent({ scope: { folders: ['/'] } }) })
    const scoped = box(host, { a: agent({ permissions: { read: 'direct', comment: 'direct' }, scope: { folders: ['Projets'] } }) })
    expect((await scoped.call('list_requests', {})).result.text).toBe('Aucune demande en attente pour vous.')

    const list = await tools.call('list_requests', {})
    expect(list.result.isError).toBeFalsy()
    expect(list.result.text).toContain('[t1] Plan.md')
    expect(list.result.text).toContain('@Relecteur reformule')
    expect(list.result.text).toContain('« Second paragraphe, plus loin. »')
    expect(list.result.text).not.toContain('pour un autre')
    expect((list.result.data as { requests: { id: string }[] }).requests.map(r => r.id)).toEqual(['t1', 't3'])

    const reply = await tools.call('reply', { thread: 't1', text: 'Reformulé en plus court.' })
    expect(reply.result.text).toBe('Réponse ajoutée : la demande est close.')
    expect(host.requests[0]!.state).toBe('done')
    // Close : elle n'est plus listee, et une seconde reponse ne la « reclot » pas.
    expect((await tools.call('list_requests', {})).result.text).not.toContain('[t1]')
    expect((await tools.call('reply', { thread: 't1', text: 'Un détail.' })).result.text).toBe('Réponse ajoutée.')
    // La fiche dit quand l'appeler, et de ne pas traiter deux fois.
    const spec = coreCatalog('server').find(s => s.name === 'list_requests')!
    expect(spec.action).toBe('read')
    expect(spec.description).toContain('reply')
    expect(spec.description).toContain('ne la traitez pas deux fois')
  })

  it('un hote sans demandes le dit', async () => {
    const r = await new ToolBox({ agent: agent(), person: { canWrite: true }, actor, runtime: 'app', host: new MemoryHost() }).call('list_requests', {})
    expect(r.result.isError).toBe(true)
    expect(r.result.text).toContain('indisponibles')
  })
})
