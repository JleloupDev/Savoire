// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Veille d'un agent sur la note ouverte : un bloc relu une fois par version,
// l'ecran d'abord, gros collage demande, bloc modifie pendant l'analyse
// abandonne, contexte de la note, reponse rangee.
import { describe, it, expect, vi } from 'vitest'
import { BlockWatcher, noteOutline, parseWatchReply, watchMessages, type WatchMemory, type WatchMemoryStore, type WatchNote, type WatchReply } from '@savoire/agent-core'
import { splitNoteBlocks, type AIChatRequest, type AIChatResponse, type AgentDefinition, type NoteBlock } from '@savoire/plugin-api'

const agent: AgentDefinition = {
  id: 'r1', name: 'Relecteur', description: '', instructions: 'Sois bref.', ownerId: 'u1',
  permissions: { read: 'direct', comment: 'direct', edit: 'propose' }, watch: {},
}

const note = (text: string, docId = 'n1'): WatchNote => ({ vaultId: 'v', docId, path: 'Note.md', text, blocks: splitNoteBlocks(text) })

class Memories implements WatchMemoryStore {
  readonly all = new Map<string, WatchMemory>()
  load(a: string, v: string, d: string): WatchMemory {
    const m = this.all.get(`${a}:${v}:${d}`)
    return m ? { ...m, seen: new Map(m.seen), remarks: [...m.remarks] } : { seen: new Map(), remarks: [] }
  }
  save(a: string, v: string, d: string, m: WatchMemory): void { this.all.set(`${a}:${v}:${d}`, { ...m, seen: new Map(m.seen), remarks: [...m.remarks] }) }
}

/** Une IA dont on choisit quand elle repond. */
class FakeAI {
  readonly calls: { req: AIChatRequest; resolve: (text: string) => void }[] = []
  chat = (req: AIChatRequest): Promise<AIChatResponse> => new Promise((resolve, reject) => {
    req.signal?.addEventListener('abort', () => reject(new DOMException('annule', 'AbortError')))
    this.calls.push({ req, resolve: text => resolve({ text, model: 'm', connection: 'c', usage: { inputTokens: 10, outputTokens: 5 } }) })
  })
  block(i: number): string {
    const content = this.calls[i].req.messages[1].content
    return content.slice(content.lastIndexOf('<<<\n') + 4, content.lastIndexOf('\n>>>'))
  }
}

const flush = () => new Promise(r => setTimeout(r, 0))

function watcher(ai: FakeAI, memory = new Memories(), extra: Partial<ConstructorParameters<typeof BlockWatcher>[0]> = {}) {
  const found: { block: NoteBlock; reply: WatchReply }[] = []
  const w = new BlockWatcher({ agent, chat: ai.chat, memory, onFinding: (_n, block, reply) => { found.push({ block, reply }) }, ...extra })
  return { w, found, memory }
}

describe('veille', () => {
  it('relit chaque bloc une fois, puis seulement ce qui change', async () => {
    const ai = new FakeAI()
    const { w, found } = watcher(ai)
    w.update(note('# Titre\n\nUn premier paragraphe.\n\nUn second.'))
    await flush()
    expect(ai.calls).toHaveLength(1)
    expect(ai.block(0)).toBe('Un premier paragraphe.')
    ai.calls[0].resolve('{"fautes":[],"conseil":null,"resume":"premier"}')
    await flush()
    expect(ai.block(1)).toBe('Un second.')
    ai.calls[1].resolve('{"fautes":[{"find":"second","replace":"deuxième","why":"style"}],"conseil":"Développe.","resume":"second"}')
    await flush()
    expect(found.map(f => f.block.text)).toEqual(['Un premier paragraphe.', 'Un second.'])
    expect(found[1].reply).toEqual({ faults: [{ find: 'second', replace: 'deuxième', why: 'style' }], advice: 'Développe.', summary: 'second' })

    // Rien de nouveau : aucun appel. Un bloc modifie : lui seul.
    w.update(note('# Titre\n\nUn premier paragraphe.\n\nUn second.'))
    await flush()
    expect(ai.calls).toHaveLength(2)
    w.update(note('# Titre\n\nUn premier paragraphe, change.\n\nUn second.'))
    await flush()
    expect(ai.calls).toHaveLength(3)
    expect(ai.block(2)).toBe('Un premier paragraphe, change.')
  })

  it('l ecran d abord', async () => {
    const ai = new FakeAI()
    const { w } = watcher(ai)
    const n = note('Haut de la note.\n\nMilieu de la note.\n\nBas de la note.')
    w.update(n, { from: n.blocks[2].from, to: n.blocks[2].to })
    await flush()
    expect(ai.block(0)).toBe('Bas de la note.')
  })

  it('bloc modifie pendant son analyse : abandonne, relu dans sa nouvelle version', async () => {
    const ai = new FakeAI()
    const { w, found } = watcher(ai)
    w.update(note('Version une.'))
    await flush()
    w.update(note('Version deux.'))
    await flush()
    expect(ai.calls).toHaveLength(2)
    expect(ai.calls[0].req.signal?.aborted).toBe(true)
    ai.calls[1].resolve('{"fautes":[],"conseil":null,"resume":"v2"}')
    await flush()
    expect(found.map(f => f.block.text)).toEqual(['Version deux.'])
  })

  it('gros collage : demande d abord ; refuse, les blocs comptent comme vus', async () => {
    const ai = new FakeAI()
    let asked = 0
    const { w } = watcher(ai, new Memories(), { askLarge: async count => { asked = count; return false } })
    const text = Array.from({ length: 35 }, (_, i) => `Paragraphe numéro ${i}.`).join('\n\n')
    w.update(note(text))
    await flush()
    expect(asked).toBe(35)
    expect(ai.calls).toHaveLength(0)
    w.update(note(`${text}\n\nUn ajout.`))
    await flush()
    expect(ai.calls).toHaveLength(1)
    expect(ai.block(0)).toBe('Un ajout.')
  })

  it('la memoire suit la note : rouvrir ne relit pas', async () => {
    const ai = new FakeAI()
    const memory = new Memories()
    const first = watcher(ai, memory)
    first.w.update(note('Déjà lu.'))
    await flush()
    ai.calls[0].resolve('{"fautes":[],"conseil":null,"resume":"lu"}')
    await flush()
    const again = watcher(ai, memory)
    again.w.update(note('Déjà lu.'))
    await flush()
    expect(ai.calls).toHaveLength(1)
  })

  it('une erreur definitive (cle refusee) arrete la veille', async () => {
    const memory = new Memories()
    const refused = Object.assign(new Error('« OpenAI » : clé refusée.'), { status: 401 })
    const w = new BlockWatcher({ agent, memory, chat: async () => { throw refused }, onFinding: () => {} })
    w.update(note('Un. Deux.'))
    await flush()
    expect(w.status().error).toBe('« OpenAI » : clé refusée.')
  })

  it('une erreur passagere ne l arrete pas : le bloc est relu plus tard', async () => {
    vi.useFakeTimers()
    try {
      let n = 0
      const found: string[] = []
      const w = new BlockWatcher({
        agent, memory: new Memories(), onFinding: (_n, b) => { found.push(b.text) },
        chat: async () => {
          if (n++ === 0) throw Object.assign(new Error('« OpenAI » : erreur 500.'), { status: 500 })
          return { text: '{"fautes":[],"conseil":null,"resume":"r"}', model: 'm', connection: 'c' }
        },
      })
      w.update(note('Un paragraphe.'))
      await vi.advanceTimersByTimeAsync(0)
      expect(w.status().error).toBeUndefined()
      expect(w.status().warning).toContain('500')
      await vi.advanceTimersByTimeAsync(5000)
      expect(found).toEqual(['Un paragraphe.'])
      expect(w.status().warning).toBeUndefined()
    } finally { vi.useRealTimers() }
  })

  it('budget atteint : pas d appel', async () => {
    const ai = new FakeAI()
    const { w } = watcher(ai, new Memories(), { canSpend: () => 'Budget du jour atteint.' })
    w.update(note('Un paragraphe.'))
    await flush()
    expect(ai.calls).toHaveLength(0)
    expect(w.status().error).toBe('Budget du jour atteint.')
  })
})

describe('contexte et reponse', () => {
  it('note courte : en entier, avec les consignes et les remarques deja faites', () => {
    const n = note('# T\n\nA.\n\nB.')
    const msgs = watchMessages(agent, n, n.blocks[1], { seen: new Map(), remarks: ['Déjà dit.'] })
    expect(msgs[0].content).toContain('Sois bref.')
    expect(msgs[1].content).toContain('en entier')
    expect(msgs[1].content).toContain('- Déjà dit.')
    expect(msgs[1].content.endsWith('<<<\nA.\n>>>')).toBe(true)
  })

  it('note longue : le plan, les resumes connus, les voisins en entier', () => {
    const paras = Array.from({ length: 30 }, (_, i) => `Paragraphe ${i} `.repeat(40))
    const n = note(`# Grand titre\n\n${paras.join('\n\n')}`)
    const target = n.blocks[20]
    const outline = noteOutline(n, { seen: new Map([[n.blocks[2].hash, 'le deuxième']]), remarks: [] }, target)
    expect(outline).toContain('# Grand titre')
    expect(outline).toContain('(résumé) le deuxième')
    expect(outline).toContain(`[19] ${n.blocks[19].text}`)
    expect(outline).toContain('[20] >>> BLOC À RELIRE <<<')
    expect(watchMessages(agent, n, target, { seen: new Map(), remarks: [] })[1].content).toContain('trop longue')
  })

  it('reponse : JSON entoure de texte, fautes absentes du bloc ignorees', () => {
    const r = parseWatchReply('Voici : {"fautes":[{"find":"ses","replace":"ces","why":"accord"},{"find":"absent","replace":"x"}],"conseil":"null","resume":"r"} fin', 'Toutes ses idées')
    expect(r).toEqual({ faults: [{ find: 'ses', replace: 'ces', why: 'accord' }], advice: null, summary: 'r' })
    expect(parseWatchReply('pas de json', 'x')).toBeNull()
  })
})

describe('revisions et contexte', () => {
  it('une faute deja proposee ou refusee n est jamais reproposee ; l IA voit les revisions', async () => {
    const ai = new FakeAI()
    const reviews = [
      { kind: 'suggestion' as const, status: 'rejected' as const, quote: 'ses', replacement: 'ces', mine: true },
      { kind: 'suggestion' as const, status: 'open' as const, quote: 'amis', replacement: 'Amis' },
      { kind: 'comment' as const, status: 'resolved' as const, quote: 'Toutes', text: 'Bien vu.' },
    ]
    const { w, found } = watcher(ai, new Memories(), { reviews: () => reviews })
    w.update(note('Toutes ses amis sont venu.'))
    await flush()
    const prompt = ai.calls[0].req.messages[1].content
    expect(prompt).toContain('suggestion REFUSÉE (par toi) : « ses » → « ces »')
    expect(prompt).toContain('suggestion en attente : « amis » → « Amis »')
    expect(prompt).toContain('commentaire résolu sur « Toutes » : Bien vu.')
    ai.calls[0].resolve(JSON.stringify({ fautes: [
      { find: 'ses', replace: 'ces', why: 'accord' },
      { find: 'amis', replace: 'Amis', why: 'majuscule' },
      { find: 'venu', replace: 'venus', why: 'accord' },
    ], conseil: null, resume: 'r' }))
    await flush()
    expect(found[0].reply.faults.map(f => f.replace)).toEqual(['venus'])
  })

  it('contexte donne par la personne : joint aux analyses, garde avec la note ; conseil ecarte : plus redonne', async () => {
    const ai = new FakeAI()
    const memory = new Memories()
    const { w, found } = watcher(ai, memory)
    w.update(note('Premier.'))
    await flush()
    w.addContext('C est un courrier formel.')
    expect(w.context()).toEqual(['C est un courrier formel.'])
    w.dismissAdvice('Ajoute une formule de politesse.')
    ai.calls[0].resolve('{"fautes":[],"conseil":null,"resume":"r"}')
    await flush()
    w.update(note('Premier.\n\nSecond.'))
    await flush()
    expect(ai.calls[1].req.messages[0].content).toContain('- C est un courrier formel.')
    expect(ai.calls[1].req.messages[1].content).toContain('Conseils écartés')
    ai.calls[1].resolve('{"fautes":[],"conseil":"Ajoute une formule de politesse.","resume":"r"}')
    await flush()
    expect(found[1].reply.advice).toBeNull()
    expect(memory.load('r1', 'v', 'n1').context).toEqual(['C est un courrier formel.'])
  })
})
