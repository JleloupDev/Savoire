// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agent Correcteur (IA) : lit la reponse du modele, propose des suggestions
// (mode suggestion) ou un commentaire (mode relecture). Fournisseur Mistral.
import { describe, it, expect, vi } from 'vitest'
import type { AgentCapability, AgentRunContext } from '@savoire/plugin-api'
import { parseCorrections, proofreaderAgent } from '@savoire/plugin-agent-proofreader'
import mistral, { MISTRAL_PROVIDER } from '@savoire/plugin-ai-mistral'

function ctx(caps: AgentCapability[], answer: string, note = 'Il ont manger une pomme.') {
  const suggest = vi.fn(() => true)
  const comment = vi.fn()
  const log: string[] = []
  const c = {
    actor: { kind: 'agent' },
    can: (x: AgentCapability) => caps.includes(x),
    note: (l: string) => log.push(l),
    ai: { chat: vi.fn(async () => ({ text: answer, model: 'm', connection: 'C' })) },
    documents: { read: async () => note, append: vi.fn() },
    index: { resolveLink: () => null, listDocuments: () => [] },
    review: { threads: () => [], comment, reply: vi.fn(), suggest },
  } as unknown as AgentRunContext
  return { c, suggest, comment, log }
}

const ANSWER = 'Voici : ```json\n{"corrections":[{"find":"Il ont manger","replace":"Ils ont mangé","why":"accord"},{"find":"absent","replace":"x"},{"find":"pomme","replace":"pomme"}]}\n```'

describe('Correcteur (IA)', () => {
  it('lit les corrections, meme entourees de texte', () => {
    expect(parseCorrections(ANSWER).map(c => c.find)).toEqual(['Il ont manger', 'absent'])
    expect(parseCorrections('pas de json')).toEqual([])
  })

  it('mode suggestion : une suggestion par faute trouvee dans la note', async () => {
    const t = ctx(['documents.read', 'review.read', 'review.write', 'review.suggest'], ANSWER)
    await proofreaderAgent.run(t.c, { docId: 'd', path: 'n.md' })
    expect(t.suggest).toHaveBeenCalledTimes(1)
    expect(t.suggest).toHaveBeenCalledWith('d', 'Il ont manger', 'Ils ont mangé', 'accord')
    expect(t.comment).not.toHaveBeenCalled()
  })

  it('mode relecture : un commentaire ; sans IA : un message clair', async () => {
    const t = ctx(['documents.read', 'review.read', 'review.write'], ANSWER)
    await proofreaderAgent.run(t.c, { docId: 'd', path: 'n.md' })
    expect(t.comment).toHaveBeenCalledWith('d', expect.stringContaining('« Il ont manger » → « Ils ont mangé »'))
    const none = ctx(['documents.read'], ANSWER)
    ;(none.c as { ai?: unknown }).ai = undefined
    await proofreaderAgent.run(none.c, { docId: 'd', path: 'n.md' })
    expect(none.log[0]).toMatch(/Aucune IA configurée/)
  })

  it('le plugin Mistral decrit le service, sans cle ni appel', async () => {
    const registerProvider = vi.fn(() => () => {})
    await mistral.onload({ ai: { registerProvider } } as never)
    expect(registerProvider).toHaveBeenCalledWith(MISTRAL_PROVIDER)
    expect(MISTRAL_PROVIDER).toMatchObject({ protocol: 'openai', requiresKey: true })
  })
})
