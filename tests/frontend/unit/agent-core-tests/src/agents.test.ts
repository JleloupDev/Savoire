// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Agents (ADR-033) : droits, outils du socle, moteur, sous-agents.
import { describe, it, expect } from 'vitest'
import {
  AgentEngine, ToolBox, coreCatalog, effectiveMode, narrowAgent, normalizePermissions, pathInScope, setPropertyChange,
  type ApprovalAnswer,
} from '@savoire/agent-core'
import type { AIChatRequest, AIChatResponse, AgentDefinition, ToolActor } from '@savoire/plugin-api'
import { MemoryHost } from './memoryHost'

const actor: ToolActor = { agentId: 'a1', agentName: 'Archiviste', onBehalfOf: { userId: 'u1', displayName: 'Jean' } }

function agent(p: Partial<AgentDefinition> = {}): AgentDefinition {
  return { id: 'a1', name: 'Archiviste', description: '', instructions: '', ownerId: 'u1', permissions: { read: 'direct' }, ...p }
}

function box(host: MemoryHost, a: AgentDefinition, opts: { canWrite?: boolean; approve?: (r: unknown) => Promise<ApprovalAnswer>; imposedMode?: 'direct' | 'propose' } = {}): ToolBox {
  return new ToolBox({ agent: a, person: { canWrite: opts.canWrite ?? true }, actor, runtime: 'app', host, ...(opts.approve ? { approve: opts.approve } : {}), ...(opts.imposedMode ? { imposedMode: opts.imposedMode } : {}) })
}

describe('droits', () => {
  it('lire ne donne jamais le droit d ecrire : les outils d ecriture ne sont pas proposes', () => {
    const names = box(new MemoryHost(), agent()).specs().map(s => s.name)
    expect(names).toContain('search')
    expect(names).not.toContain('edit_note')
    expect(names).not.toContain('create_note')
  })

  it('un lecteur du vault ne fait jamais ecrire un agent, quel que soit son mode', () => {
    const a = agent({ permissions: { read: 'direct', edit: 'direct', create: 'direct' } })
    expect(effectiveMode(a, 'edit', { canWrite: false })).toBe('deny')
    expect(box(new MemoryHost(), a, { canWrite: false }).specs().map(s => s.name)).not.toContain('edit_note')
  })

  it('un mode sans sens pour l action devient interdit', () => {
    expect(normalizePermissions({ create: 'propose' as never }).create).toBe('deny')
  })

  it('la portee limite aux dossiers, sous-dossiers compris', () => {
    expect(pathInScope({ folders: ['Projets'] }, 'Projets/2026/a.md')).toBe(true)
    expect(pathInScope({ folders: ['Projets'] }, 'Projets2/a.md')).toBe(false)
    expect(pathInScope(undefined, 'x.md')).toBe(true)
  })

  it('un sous-agent n a jamais plus que son parent', () => {
    const parent = agent({ permissions: { read: 'direct', edit: 'propose', create: 'ask' }, scope: { folders: ['Projets'] } })
    const child = agent({ id: 'c', permissions: { read: 'direct', edit: 'direct', create: 'direct', delete: 'direct' }, scope: { folders: ['Projets/A', 'Perso'] } })
    const n = narrowAgent(parent, child)
    expect(n.permissions).toMatchObject({ read: 'direct', edit: 'propose', create: 'ask', delete: 'deny' })
    expect(n.scope?.folders).toEqual(['Projets/A'])
  })

  it('le catalogue du serveur contient les outils du socle', () => {
    const names = coreCatalog('server').map(s => s.name)
    expect(names).toEqual(expect.arrayContaining(['search', 'read_note', 'edit_note', 'create_note', 'move_note', 'trash_note']))
  })
})

describe('outils du socle', () => {
  it('chercher, lire : les notes lues deviennent des sources', async () => {
    const host = new MemoryHost({ 'Projets/Facturation.md': 'On facture au mois.', 'Autre.md': 'rien' })
    const tb = box(host, agent())
    const found = await tb.call('search', { query: 'facture' })
    expect(found.result.sources?.map(s => s.path)).toEqual(['Projets/Facturation.md'])
    const read = await tb.call('read_note', { path: 'projets/facturation.md' })
    expect(read.result.text).toContain('On facture au mois.')
  })

  it('une note cachee a la personne n existe pas pour l agent', async () => {
    const host = new MemoryHost({ 'Secret.md': 'mot de passe' })
    host.hidden.add('Secret.md')
    const r = await box(host, agent()).call('read_note', { path: 'Secret.md' })
    expect(r.result.isError).toBe(true)
    expect((await box(host, agent()).call('search', { query: 'passe' })).result.sources ?? []).toEqual([])
  })

  it('hors de la portee : refuse, meme en lecture', async () => {
    const host = new MemoryHost({ 'Perso/a.md': 'x', 'Projets/b.md': 'x' })
    const tb = box(host, agent({ scope: { folders: ['Projets'] } }))
    expect((await tb.call('read_note', { path: 'Perso/a.md' })).result.isError).toBe(true)
    expect((await tb.call('list_notes', {})).result.data).toMatchObject({ items: [{ path: 'Projets/b.md' }] })
  })

  it('requete sur une base sans texte (vide, sans ligne) : la base est trouvee par son chemin ou son nom', async () => {
    const host = new MemoryHost({ 'Projets/DB.base': '' })
    const asked: unknown[] = []
    host.readNote = async () => null
    host.power = async (_c, _m, params) => { asked.push(params.from); return { rows: [], total: 0 } }
    const tb = box(host, agent())
    for (const base of ['Projets/DB.base', 'Projets/DB']) {
      const r = await tb.call('query', { base })
      expect(r.result.isError).toBeFalsy()
      expect(r.result.text).toContain('0 résultat')
    }
    expect(asked).toEqual([{ base: host.idOf('Projets/DB.base') }, { base: host.idOf('Projets/DB.base') }])
    expect((await tb.call('query', { base: 'Inconnue.base' })).result.text).toContain('Base introuvable')
  })

  it('ajouter une image : rangee dans le dossier de la note, lien a la fin, serveur seulement', async () => {
    const host = new MemoryHost({ 'Projets/Plan.md': 'Le plan.', 'Projets/Plan/Tableau.jpg': '' })
    const a = agent({ permissions: { read: 'direct', edit: 'direct' } })
    expect(box(host, a).specs().map(s => s.name)).not.toContain('add_image')
    const server = new ToolBox({ agent: a, person: { canWrite: true }, actor, runtime: 'server', host })
    const r = await server.call('add_image', { path: 'Projets/Plan.md', fileId: 'f-1', fileName: 'Tableau.JPG' })
    expect(r.result.isError).toBeFalsy()
    expect(host.notes.get('f-1')?.path).toBe('Projets/Plan/Tableau 1.jpg')
    expect(host.attached.get('f-1')).toBe(host.idOf('Projets/Plan.md'))
    expect(host.content('Projets/Plan.md')).toBe('Le plan.\n\n![[Projets/Plan/Tableau 1.jpg]]\n')
    const bad = await server.call('add_image', { path: 'Projets/Plan.md', fileId: '../x' })
    expect(bad.result.isError).toBe(true)
    const propose = new ToolBox({ agent: agent({ permissions: { read: 'direct', edit: 'propose' } }), person: { canWrite: true }, actor, runtime: 'server', host })
    expect((await propose.call('add_image', { path: 'Projets/Plan.md', fileId: 'f-2' })).result.text).toContain('mode proposition')
  })

  it('ajouter un fichier : range seul a son chemin, jamais ecrase, serveur seulement', async () => {
    const host = new MemoryHost({ 'Bibliothèques/lib.js': 'ancien' })
    const a = agent({ permissions: { read: 'direct', create: 'direct' } })
    expect(box(host, a).specs().map(s => s.name)).not.toContain('add_file')
    const server = new ToolBox({ agent: a, person: { canWrite: true }, actor, runtime: 'server', host })
    const r = await server.call('add_file', { path: 'Bibliothèques/lib.js', fileId: 'f-1' })
    expect(r.result.isError).toBeFalsy()
    expect(host.notes.get('f-1')?.path).toBe('Bibliothèques/lib 1.js')
    expect(host.attached.get('f-1')).toBe('')
    expect((await server.call('add_file', { path: '../x.js', fileId: 'f-2' })).result.isError).toBe(true)
    expect((await server.call('add_file', { path: 'a.js', fileId: '../x' })).result.isError).toBe(true)
  })

  it('ajouter une archive deballee : tous ses fichiers sous le dossier, l existant garde', async () => {
    const host = new MemoryHost({ 'Données/geo/a.json': 'ancien' })
    const server = new ToolBox({ agent: agent({ permissions: { read: 'direct', create: 'direct' } }), person: { canWrite: true }, actor, runtime: 'server', host })
    const r = await server.call('add_file', { path: 'Données/', files: [{ fileId: 'f-1', path: 'geo/a.json' }, { fileId: 'f-2', path: 'photos/b.jpg' }] })
    expect(r.result.text).toContain('1 fichier(s) rangé(s) dans Données, 1 déjà présent(s)')
    expect(host.notes.get('f-2')?.path).toBe('Données/photos/b.jpg')
    expect(host.notes.has('f-1')).toBe(false)
    expect((await server.call('add_file', { path: 'X', files: [{ fileId: 'f-3', path: '../y' }] })).result.isError).toBe(true)
  })

  it('lire des pages d un PDF : lecture partielle par l hote, sinon decoupe du texte extrait', async () => {
    const host = new MemoryHost({ 'Docs/Gros.pdf': '', 'Docs/Petit.pdf': '---\npages: 3\n---\n\n## Page 1\n\nUn\n\n## Page 2\n\nDeux\n\n## Page 3\n\nTrois\n', 'n.md': 'x' })
    host.pagedFiles.set('Docs/Gros.pdf', Array.from({ length: 400 }, (_, i) => `Texte ${i + 1}`))
    const b = box(host, agent({ permissions: { read: 'direct' } }))
    const r = await b.call('read_note', { path: 'Docs/Gros.pdf', pages: '120-122' })
    expect(r.result.text).toContain('Pages 120-122 sur 400')
    expect(r.result.text).toContain('## Page 121\n\nTexte 121')
    expect(host.pageReads).toEqual([['Docs/Gros.pdf', 120, 122]])
    // 50 pages au plus : la suite est indiquee.
    const many = await b.call('read_note', { path: 'Docs/Gros.pdf', pages: '1-80' })
    expect(host.pageReads.at(-1)).toEqual(['Docs/Gros.pdf', 1, 50])
    expect(many.result.text).toContain('pages 51-80')
    expect((await b.call('read_note', { path: 'Docs/Gros.pdf', pages: '500' })).result.text).toContain('400 page(s)')
    // Sans lecture partielle pour ce fichier : les titres « Page N » du texte extrait.
    const small = await b.call('read_note', { path: 'Docs/Petit.pdf', pages: '2' })
    expect(small.result.text).toContain('## Page 2\n\nDeux')
    expect(small.result.text).not.toContain('Trois')
    expect((await b.call('read_note', { path: 'n.md', pages: '1' })).result.isError).toBe(true)
    expect((await b.call('read_note', { path: 'Docs/Petit.pdf', pages: 'x' })).result.isError).toBe(true)
  })

  it('modifier en direct : la note change, la trace porte le nom de l agent', async () => {
    const host = new MemoryHost({ 'a.md': 'Bonjour le monde' })
    const r = await box(host, agent({ permissions: { read: 'direct', edit: 'direct' } })).call('edit_note', { path: 'a.md', find: 'le monde', replace: 'tout le monde' })
    expect(r.result.isError).toBeFalsy()
    expect(host.content('a.md')).toBe('Bonjour tout le monde')
    expect(host.review.map(e => [e.kind, e.author])).toEqual([['edit', 'Archiviste (IA), pour Jean']])
  })

  it('modifier en proposition : la note ne change pas, une suggestion attend', async () => {
    const host = new MemoryHost({ 'a.md': 'Bonjour le monde' })
    await box(host, agent({ permissions: { read: 'direct', edit: 'propose' } })).call('edit_note', { path: 'a.md', find: 'le monde', replace: 'tout le monde' })
    expect(host.content('a.md')).toBe('Bonjour le monde')
    expect(host.review).toMatchObject([{ kind: 'suggestion', quote: 'le monde', replacement: 'tout le monde' }])
  })

  it('une correction deja proposee ou refusee n est pas reproposee', async () => {
    const host = new MemoryHost({ 'a.md': 'Bonjour le monde' })
    const b = box(host, agent({ permissions: { read: 'direct', edit: 'propose' } }))
    await b.call('edit_note', { path: 'a.md', find: 'le monde', replace: 'tout le monde' })
    host.review[0]!.status = 'rejected'
    const again = await b.call('edit_note', { path: 'a.md', find: 'le monde', replace: 'tout le monde' })
    expect(again.result.text).toContain('déjà dans la Révision')
    expect(host.review.filter(e => e.kind === 'suggestion')).toHaveLength(1)
  })

  it('le serveur peut imposer la proposition, jamais l inverse', async () => {
    const host = new MemoryHost({ 'a.md': 'x' })
    await box(host, agent({ permissions: { read: 'direct', edit: 'direct' } }), { imposedMode: 'propose' }).call('append', { path: 'a.md', text: 'y' })
    expect(host.content('a.md')).toBe('x')
    expect(host.review[0]?.kind).toBe('suggestion')
  })

  it('un passage ambigu est refuse plutot que modifie au hasard', async () => {
    const host = new MemoryHost({ 'a.md': 'oui oui' })
    const r = await box(host, agent({ permissions: { read: 'direct', edit: 'direct' } })).call('edit_note', { path: 'a.md', find: 'oui', replace: 'non' })
    expect(r.result.isError).toBe(true)
    expect(host.content('a.md')).toBe('oui oui')
  })

  it('demander avant : rien ne se fait sans l accord', async () => {
    const host = new MemoryHost({ 'Inbox/a.md': 'x' })
    const a = agent({ permissions: { read: 'direct', organize: 'ask' } })
    const refused = await box(host, a, { approve: async () => 'refused' }).call('move_note', { path: 'Inbox/a.md', to: 'Archives/' })
    expect(refused.approval).toBe('refused')
    expect(host.writes).toEqual([])
    const pending = await box(host, a, { approve: async () => ({ pending: 'ap-1' }) }).call('move_note', { path: 'Inbox/a.md', to: 'Archives/' })
    expect(pending.result.pending).toEqual({ approvalId: 'ap-1' })
    let asked = ''
    const done = await box(host, a, { approve: async r => { asked = (r as { summary: string }).summary; return 'approved' } }).call('move_note', { path: 'Inbox/a.md', to: 'Archives/' })
    expect(done.approval).toBe('approved')
    expect(asked).toContain('Déplacer ou renommer')
    expect(host.writes).toEqual(['move Archives/a.md'])
  })

  it('creer une note : refuse si elle existe deja', async () => {
    const host = new MemoryHost({ 'Réunions/a.md': 'x' })
    const tb = box(host, agent({ permissions: { read: 'direct', create: 'direct' } }))
    expect((await tb.call('create_note', { path: 'Réunions/a', content: 'y' })).result.isError).toBe(true)
    expect((await tb.call('create_note', { path: 'Réunions/b', content: 'y' })).result.text).toContain('Réunions/b.md')
  })

  it('creer une note : refuse un dessin Excalidraw et renvoie vers drawing_create', async () => {
    const host = new MemoryHost({})
    const tb = box(host, agent({ permissions: { read: 'direct', create: 'direct' } }))
    const tries = [
      { path: 'Plan.excalidraw', content: '' },
      { path: 'Plan.excalidraw.md', content: 'x' },
      { path: 'Plan', content: '# Plan\n```json\n{ "type": "excalidraw", "version": 2, "elements": [] }\n```' },
      { path: 'Plan', content: '---\nexcalidraw-plugin: parsed\n---\n# Drawing' },
    ]
    for (const args of tries) {
      const r = (await tb.call('create_note', args)).result
      expect(r.isError).toBe(true)
      expect(r.text).toContain('drawing_create')
    }
    expect((await tb.call('create_note', { path: 'Notes', content: 'J’aime Excalidraw.' })).result.text).toContain('Note créée')
  })

  it('poser une propriete dans le frontmatter', () => {
    expect(setPropertyChange('Texte', 'statut', 'fait')).toEqual({ from: 0, to: 0, text: '---\nstatut: fait\n---\n' })
    const c = setPropertyChange('---\nstatut: en cours\nauteur: Jean\n---\nTexte', 'statut', 'fait')!
    expect(c.text).toBe('statut: fait\nauteur: Jean')
    expect(setPropertyChange('---\nstatut: fait\n---\n', 'statut', 'fait')).toBeNull()
  })
})

/** Un modele scripte : rend les reponses prevues, dans l'ordre. */
function scripted(answers: AIChatResponse[]): { chat: (r: AIChatRequest) => Promise<AIChatResponse>; requests: AIChatRequest[] } {
  const requests: AIChatRequest[] = []
  return {
    requests,
    chat: async r => {
      requests.push(r)
      const a = answers.shift()
      if (!a) throw new Error('plus de reponse prevue')
      return a
    },
  }
}

const reply = (text: string, toolCalls?: { name: string; args: object }[], tokens = 10): AIChatResponse => ({
  text, model: 'test', connection: 'Test', usage: { inputTokens: tokens, outputTokens: tokens },
  ...(toolCalls ? { toolCalls: toolCalls.map((c, i) => ({ id: `c${i}`, name: c.name, arguments: JSON.stringify(c.args) })) } : {}),
})

describe('moteur', () => {
  it('cherche, lit, puis repond avec ses sources ; chaque etape garde ses tokens', async () => {
    const host = new MemoryHost({ 'Projets/Facturation.md': 'On facture au mois.' })
    const a = agent()
    const ai = scripted([
      reply('', [{ name: 'search', args: { query: 'facture' } }]),
      reply('', [{ name: 'read_note', args: { path: 'Projets/Facturation.md' } }]),
      reply('On facture au mois, voir [[Projets/Facturation.md]].'),
    ])
    const engine = new AgentEngine({ agent: a, person: { canWrite: true }, actor, tools: box(host, a), chat: ai.chat })
    const run = await engine.run('Comment facture-t-on ?')
    expect(run.status).toBe('done')
    expect(run.answer).toContain('[[Projets/Facturation.md]]')
    expect(run.sources.map(s => s.path)).toEqual(['Projets/Facturation.md'])
    expect(run.steps.map(s => `${s.kind}:${s.name ?? ''}`)).toEqual(['model:', 'tool:search', 'model:', 'tool:read_note', 'model:'])
    expect(run.usage).toEqual({ inputTokens: 30, outputTokens: 30 })
    // Le modele recoit les outils permis et ses consignes.
    expect(ai.requests[0]!.tools!.map(t => t.name)).toContain('search')
    expect(ai.requests[0]!.messages[0]!.content).toContain('Archiviste')
    expect(ai.requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'c0' })
  })

  it('un outil interdit demande par le modele est refuse, la note ne change pas', async () => {
    const host = new MemoryHost({ 'a.md': 'x' })
    const a = agent()
    const ai = scripted([reply('', [{ name: 'append', args: { path: 'a.md', text: 'pirate' } }]), reply('Je ne peux pas.')])
    const run = await new AgentEngine({ agent: a, person: { canWrite: true }, actor, tools: box(host, a), chat: ai.chat }).run('Ecris')
    expect(host.content('a.md')).toBe('x')
    expect(run.steps[1]).toMatchObject({ kind: 'tool', status: 'error' })
  })

  it('le budget arrete l execution', async () => {
    const host = new MemoryHost({ 'a.md': 'x' })
    const a = agent({ budget: { maxTokensPerRun: 15 } })
    const ai = scripted([reply('', [{ name: 'search', args: { query: 'x' } }]), reply('fin')])
    const run = await new AgentEngine({ agent: a, person: { canWrite: true }, actor, tools: box(host, a), chat: ai.chat }).run('?')
    expect(run.status).toBe('budget')
    expect(ai.requests.length).toBe(1)
  })

  it('la limite d etapes arrete une boucle sans fin', async () => {
    const host = new MemoryHost({ 'a.md': 'x' })
    const a = agent({ budget: { maxSteps: 2 } })
    const ai = scripted([reply('', [{ name: 'search', args: { query: 'x' } }]), reply('', [{ name: 'search', args: { query: 'x' } }])])
    const run = await new AgentEngine({ agent: a, person: { canWrite: true }, actor, tools: box(host, a), chat: ai.chat }).run('?')
    expect(run.status).toBe('stopped')
  })

  it('deleguer : l execution enfant est rattachee, avec au plus les droits du parent', async () => {
    const host = new MemoryHost({ 'a.md': 'x' })
    const parent = agent({ permissions: { read: 'direct' } })
    const childAgent = agent({ id: 'c', name: 'Rédacteur', permissions: { read: 'direct', edit: 'direct' } })
    const childAi = scripted([reply('', [{ name: 'append', args: { path: 'a.md', text: 'y' } }]), reply('fait')])
    const engine = new AgentEngine({
      agent: parent, person: { canWrite: true }, actor, tools: box(host, parent), chat: scripted([]).chat,
      forChild: a => ({ agent: a, person: { canWrite: true }, actor: { ...actor, agentId: a.id, agentName: a.name }, tools: box(host, a), chat: childAi.chat }),
    })
    const parentRun = { id: 'p', agentId: 'a1', agentName: 'Archiviste', userId: 'u1', input: '', status: 'running' as const, startedAt: '', steps: [], usage: { inputTokens: 0, outputTokens: 0 }, sources: [] }
    const child = await engine.delegate(parentRun, childAgent, 'Ajoute y')
    expect(child.parentRunId).toBe('p')
    expect(parentRun.steps[0]).toMatchObject({ kind: 'delegate', childRunId: child.id })
    // Le parent ne peut pas ecrire : le sous-agent non plus.
    expect(host.content('a.md')).toBe('x')
    expect(childAi.requests[0]!.tools!.map(t => t.name)).not.toContain('append')
  })

  it('le texte arrive au fil de l eau dans l etape du modele', async () => {
    const host = new MemoryHost({})
    const a = agent()
    const seen: string[] = []
    const chat = async (r: AIChatRequest): Promise<AIChatResponse> => {
      r.onDelta?.({ text: 'Bon' })
      r.onDelta?.({ text: 'jour' })
      return reply('Bonjour')
    }
    const run = await new AgentEngine({
      agent: a, person: { canWrite: true }, actor, tools: box(host, a), chat,
      onUpdate: r => { const t = r.steps[0]?.text; if (r.steps[0]?.status === 'running' && t) seen.push(t) },
    }).run('?')
    expect(seen).toEqual(['Bon', 'Bonjour'])
    expect(run.answer).toBe('Bonjour')
  })
})

describe('orchestrateur', () => {
  const chef = (p: Partial<AgentDefinition> = {}) => agent({ id: 'chef', name: 'Chef', permissions: { read: 'direct', edit: 'direct', delegate: 'direct' }, delegates: ['red'], ...p })
  const red = (p: Partial<AgentDefinition> = {}) => agent({ id: 'red', name: 'Rédacteur', permissions: { read: 'direct', edit: 'direct', delegate: 'direct' }, ...p })

  /** Un agent par modele scripte ; forChild relie chaque sous-agent a son script. */
  function team(host: MemoryHost, known: AgentDefinition[], scripts: Record<string, ReturnType<typeof scripted>>, canWrite = true) {
    const deps = (a: AgentDefinition) => ({
      agent: a, person: { canWrite }, actor: { ...actor, agentId: a.id, agentName: a.name }, tools: box(host, a, { canWrite }),
      chat: scripts[a.id]!.chat, agents: known, forChild: deps,
    })
    return deps
  }

  it('sans le droit de deleguer, l outil delegate n est pas propose', async () => {
    const host = new MemoryHost({})
    const a = chef({ permissions: { read: 'direct' } })
    const ai = scripted([reply('ok')])
    await new AgentEngine(team(host, [a, red()], { chef: ai })(a)).run('?')
    expect(ai.requests[0]!.tools!.map(t => t.name)).not.toContain('delegate')
    // Avec le droit mais sans sous-agent permis : pas d'outil non plus.
    const b = chef({ delegates: [] })
    const ai2 = scripted([reply('ok')])
    await new AgentEngine(team(host, [b, red()], { chef: ai2 })(b)).run('?')
    expect(ai2.requests[0]!.tools!.map(t => t.name)).not.toContain('delegate')
  })

  it('l outil delegate lance le sous-agent avec au plus les droits du parent ; ses tokens remontent', async () => {
    const host = new MemoryHost({ 'a.md': 'x' })
    const a = chef({ permissions: { read: 'direct', delegate: 'direct' } })
    const chefAi = scripted([reply('', [{ name: 'delegate', args: { agent: 'Rédacteur', task: 'Ajoute y à a.md' } }]), reply('Le rédacteur a répondu.')])
    const redAi = scripted([reply('', [{ name: 'append', args: { path: 'a.md', text: 'y' } }], 5), reply('Pas le droit.', undefined, 5)])
    const run = await new AgentEngine(team(host, [a, red()], { chef: chefAi, red: redAi })(a)).run('?')
    expect(run.status).toBe('done')
    expect(chefAi.requests[0]!.tools!.map(t => t.name)).toContain('delegate')
    // Le chef ne peut pas modifier : le redacteur non plus.
    expect(redAi.requests[0]!.tools!.map(t => t.name)).not.toContain('append')
    expect(host.content('a.md')).toBe('x')
    const step = run.steps.find(s => s.kind === 'delegate')!
    expect(step).toMatchObject({ status: 'done', name: 'Rédacteur' })
    expect(run.children?.[0]).toMatchObject({ id: step.childRunId, parentRunId: run.id, parentStepId: step.id, answer: 'Pas le droit.' })
    expect(run.usage).toEqual({ inputTokens: 30, outputTokens: 30 })
    expect(chefAi.requests[1]!.messages.at(-1)!.content).toContain('Pas le droit.')
  })

  it('un agent inconnu, ou lui-meme, n est pas delegable', async () => {
    const host = new MemoryHost({})
    const a = chef({ delegates: ['chef', 'red'] })
    const chefAi = scripted([reply('', [{ name: 'delegate', args: { agent: 'chef', task: 't' } }]), reply('fin')])
    const run = await new AgentEngine(team(host, [a, red()], { chef: chefAi })(a)).run('?')
    expect(run.steps.find(s => s.kind === 'delegate')).toMatchObject({ status: 'error' })
    expect(chefAi.requests[0]!.tools!.find(t => t.name === 'delegate')!.description).not.toContain('id chef')
  })

  it('profondeur : trois niveaux au plus', async () => {
    const host = new MemoryHost({})
    const ids = ['n0', 'n1', 'n2', 'n3', 'n4']
    const known = ids.map((id, i) => agent({ id, name: id, permissions: { read: 'direct', delegate: 'direct' }, ...(ids[i + 1] ? { delegates: [ids[i + 1]!] } : {}) }))
    const scripts: Record<string, ReturnType<typeof scripted>> = {}
    for (const [i, id] of ids.entries()) scripts[id] = scripted(ids[i + 1] ? [reply('', [{ name: 'delegate', args: { agent: ids[i + 1], task: 't' } }]), reply(`fin ${id}`)] : [reply(`fin ${id}`)])
    const run = await new AgentEngine(team(host, known, scripts)(known[0]!)).run('?')
    expect(run.status).toBe('done')
    // n0 -> n1 -> n2 -> n3 ; n3 (profondeur 3) n'a plus l'outil.
    expect(scripts.n3!.requests[0]!.tools?.map(t => t.name) ?? []).not.toContain('delegate')
    expect(scripts.n4!.requests.length).toBe(0)
  })

  it('budget par enfant : le sous-agent s arrete a son plafond', async () => {
    const host = new MemoryHost({})
    const a = chef({ budget: { maxTokensPerChild: 15 } })
    const chefAi = scripted([reply('', [{ name: 'delegate', args: { agent: 'red', task: 't' } }]), reply('fin')])
    const redAi = scripted([reply('', [{ name: 'search', args: { query: 'x' } }]), reply('jamais')])
    const run = await new AgentEngine(team(host, [a, red()], { chef: chefAi, red: redAi })(a)).run('?')
    expect(run.children?.[0]?.status).toBe('budget')
    expect(redAi.requests.length).toBe(1)
    expect(run.steps.find(s => s.kind === 'delegate')).toMatchObject({ status: 'error' })
  })

  it('mode demander : sans accord, pas de sous-agent', async () => {
    const host = new MemoryHost({})
    const a = chef({ permissions: { read: 'direct', delegate: 'ask' } })
    const chefAi = scripted([reply('', [{ name: 'delegate', args: { agent: 'red', task: 't' } }]), reply('fin')])
    const redAi = scripted([reply('jamais')])
    const asked: unknown[] = []
    const run = await new AgentEngine({ ...team(host, [a, red()], { chef: chefAi, red: redAi })(a), approve: async r => { asked.push(r); return 'refused' } }).run('?')
    expect(asked.length).toBe(1)
    expect(redAi.requests.length).toBe(0)
    expect(run.steps.find(s => s.kind === 'approval')).toMatchObject({ status: 'refused' })
  })

  it('un lecteur peut deleguer, le sous-agent ne peut pas ecrire', () => {
    expect(effectiveMode(chef(), 'delegate', { canWrite: false })).toBe('direct')
    expect(effectiveMode(chef(), 'edit', { canWrite: false })).toBe('deny')
  })
})
