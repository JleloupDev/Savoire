// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent d'Excalidraw, suite (ADR-033) : fleches attachees, deplacer,
// modifier, effacer, schema place tout seul, creer et lister les dessins.
import { describe, it, expect, vi } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { PluginAPI, PluginTool, ToolContext } from '@savoire/plugin-api'
import { SCENE_PROPOSAL, excalidrawAgentTools } from '../../../../../packages/plugins/plugin-excalidraw/src/agentTools'
import { SceneBinding, applyScenePatch, type SceneElement, type ScenePatch } from '../../../../../packages/plugins/plugin-excalidraw/src/binding'
import { SceneDraft, edgePoint, layoutDiagram, shapeElements } from '../../../../../packages/plugins/plugin-excalidraw/src/scene'

const actor = { agentId: 'a', agentName: 'Dessinateur', onBehalfOf: { userId: 'u', displayName: 'Jean' } }
const direct = { mode: 'direct', actor } as ToolContext
const propose = { mode: 'propose', actor } as ToolContext

function setup(files: { docId: string; path: string }[] = [{ docId: 'd1', path: 'Schémas/Plan.excalidraw' }]) {
  const trees = new Map<string, InMemorySharedTree>()
  const tree = (id: string) => { let t = trees.get(id); if (!t) { t = new InMemorySharedTree(); trees.set(id, t) } return t }
  const proposeFn = vi.fn(async () => 'p1')
  const createFile = vi.fn(async (path: string) => { files.push({ docId: `new-${files.length}`, path }) })
  const api = {
    vault: {
      getFileTree: () => files,
      resolveDocumentId: (p: string) => files.find(f => f.path === p)?.docId,
      openTree: async (id: string) => tree(id),
      closeTree: () => {},
      createFile,
      createFolder: async () => {},
    },
    review: { propose: proposeFn },
  } as unknown as PluginAPI
  const tools = new Map<string, PluginTool>(excalidrawAgentTools(api).map(t => [t.spec.name, t]))
  const run = (name: string, args: Record<string, unknown>, ctx = direct) => tools.get(name)!.run(args, ctx)
  const elements = (id = 'd1') => new SceneBinding({ tree: tree(id), getElements: () => null, applyElements: () => {}, hasFile: () => false, addFiles: () => {} })
    .readElements().filter(e => !e.isDeleted)
  return { run, tools, tree, elements, propose: proposeFn, createFile, files }
}

const byType = (els: SceneElement[], type: string) => els.filter(e => e.type === type)
const idsIn = (text: string) => Object.fromEntries([...text.matchAll(/(\w+) → (\w+)/g)].map(m => [m[1], m[2]]))

describe('excalidraw : geometrie', () => {
  it('une fleche part du bord de la forme, pas de son centre', () => {
    const [box] = shapeElements({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 })
    expect(edgePoint(box!, { x: 300, y: 25 }, 0)).toEqual({ x: 100, y: 25 })
    const [disk] = shapeElements({ type: 'ellipse', x: 0, y: 0, width: 100, height: 100 })
    const p = edgePoint(disk!, { x: 50, y: -200 }, 0)
    expect(p.x).toBeCloseTo(50)
    expect(p.y).toBeCloseTo(0)
  })

  it('un texte trop long agrandit sa forme', () => {
    const [box] = shapeElements({ type: 'rectangle', x: 0, y: 0, width: 40, height: 20, text: 'Un texte bien plus long que la boîte' })
    expect(Number(box!.width)).toBeGreaterThan(200)
  })

  it('les couleurs se donnent aussi par leur nom', () => {
    const [box] = shapeElements({ type: 'rectangle', x: 0, y: 0, color: 'rouge', fill: 'bleu' })
    expect(box).toMatchObject({ strokeColor: '#e03131', backgroundColor: '#a5d8ff' })
  })

  it('schema : une couche par etape, les fleches de gauche a droite', () => {
    const boxes = layoutDiagram(
      [{ key: 'a', text: 'Idée' }, { key: 'b', text: 'Plan' }, { key: 'c', text: 'Test' }, { key: 'd', text: 'Fin' }],
      [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd' }, { from: 'd', to: 'a' }],
      'right', { x: 0, y: 0 },
    )
    const x = (k: string) => boxes.get(k)!.x
    expect(x('a')).toBe(0)
    expect(x('b')).toBe(x('c'))
    expect(x('b')).toBeGreaterThan(x('a'))
    expect(x('d')).toBeGreaterThan(x('b'))
    // b et c, dans la meme couche, ne se recouvrent pas.
    const [b, c] = [boxes.get('b')!, boxes.get('c')!].sort((p, q) => p.y - q.y)
    expect(b!.y + b!.height).toBeLessThan(c!.y)
  })

  it('brouillon : deplacer une forme recentre son texte et redessine ses fleches', () => {
    const [a, label] = shapeElements({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50, text: 'A' })
    const [b] = shapeElements({ type: 'rectangle', x: 300, y: 0, width: 100, height: 50 })
    const [arrow] = shapeElements({ type: 'arrow', x: 0, y: 0 })
    const draft = new SceneDraft([a!, label!, b!, arrow!])
    draft.connect(arrow!.id, 'start', a!.id)
    draft.connect(arrow!.id, 'end', b!.id)
    expect(draft.get(arrow!.id)).toMatchObject({ x: 108, y: 25, points: [[0, 0], [184, 0]] })
    expect(draft.get(a!.id)!.boundElements).toEqual([{ type: 'text', id: label!.id }, { type: 'arrow', id: arrow!.id }])
    draft.move(b!.id, { y: 300 })
    const moved = draft.get(arrow!.id)!
    expect((moved.points as number[][])[1]![1]).toBeGreaterThan(200)
    draft.move(a!.id, { x: 50 })
    const l = draft.get(label!.id)!
    expect(Number(l.x) + Number(l.width) / 2).toBeCloseTo(100)
  })
})

describe('excalidraw : outils d agent', () => {
  it('drawing_add : des fleches attachees par cle, les identifiants rendus', async () => {
    const { run, elements } = setup()
    const r = await run('drawing_add', { path: 'Schémas/Plan', shapes: [
      { type: 'rectangle', key: 'idee', x: 0, y: 0, text: 'Idée' },
      { type: 'arrow', from: 'idee', to: 'fin', text: 'mène à' },
      { type: 'ellipse', key: 'fin', x: 400, y: 0, text: 'Fin' },
    ] })
    const ids = idsIn(r.text)
    expect(r.text).toMatch(/^3 forme\(s\) ajoutée\(s\) à Schémas\/Plan\.excalidraw\./)
    expect(Object.keys(ids)).toEqual(['idee', 'fin'])
    const [arrow] = byType(elements(), 'arrow')
    expect(arrow).toMatchObject({ startBinding: { elementId: ids.idee }, endBinding: { elementId: ids.fin } })
    const read = (await run('drawing_read', { path: 'Schémas/Plan' })).text
    expect(read).toContain(`de ${ids.idee} vers ${ids.fin}`)
    expect(read).toContain('« mène à »')
  })

  it('drawing_add : une forme sans position se place a droite du dessin', async () => {
    const { run, elements } = setup()
    await run('drawing_add', { path: 'Schémas/Plan', shapes: [{ type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }] })
    await run('drawing_add', { path: 'Schémas/Plan', shapes: [{ type: 'diamond', text: 'Choix' }] })
    const [diamond] = byType(elements(), 'diamond')
    expect(Number(diamond!.x)).toBeGreaterThan(100)
  })

  it('drawing_update : deplacer, recolorer, renommer ; la fleche suit', async () => {
    const { run, elements } = setup()
    const ids = idsIn((await run('drawing_add', { path: 'Schémas/Plan', shapes: [
      { type: 'rectangle', key: 'a', x: 0, y: 0, width: 100, height: 50, text: 'A' },
      { type: 'rectangle', key: 'b', x: 300, y: 0, width: 100, height: 50 },
      { type: 'arrow', key: 'f', from: 'a', to: 'b' },
    ] })).text)
    const r = await run('drawing_update', { path: 'Schémas/Plan', changes: [
      { id: ids.b, dy: 200, fill: 'vert' },
      { id: ids.a, text: 'Départ', color: 'bleu' },
    ] })
    expect(r.text).toContain('Dessin modifié')
    const els = elements()
    expect(els.find(e => e.id === ids.b)).toMatchObject({ y: 200, backgroundColor: '#b2f2bb' })
    const label = els.find(e => e.type === 'text' && e.containerId === ids.a)
    expect(label).toMatchObject({ text: 'Départ', strokeColor: '#1971c2' })
    const arrow = els.find(e => e.id === ids.f)!
    expect((arrow.points as number[][])[1]![1]).toBeGreaterThan(100)
    // Detacher la fleche, puis la rattacher ailleurs.
    await run('drawing_update', { path: 'Schémas/Plan', changes: [{ id: ids.f, to: '' }] })
    expect(elements().find(e => e.id === ids.f)!.endBinding).toBeNull()
    expect(elements().find(e => e.id === ids.b)!.boundElements).toBeNull()
  })

  it('drawing_delete : la forme et son texte partent, la fleche reste detachee', async () => {
    const { run, elements } = setup()
    const ids = idsIn((await run('drawing_add', { path: 'Schémas/Plan', shapes: [
      { type: 'rectangle', key: 'a', x: 0, y: 0, text: 'A' },
      { type: 'rectangle', key: 'b', x: 300, y: 0 },
      { type: 'arrow', key: 'f', from: 'a', to: 'b' },
    ] })).text)
    const r = await run('drawing_delete', { path: 'Schémas/Plan', ids: [ids.a] })
    expect(r.text).toBe('1 élément(s) supprimé(s) de Schémas/Plan.excalidraw.')
    const els = elements()
    expect(els.map(e => e.type).sort()).toEqual(['arrow', 'rectangle'])
    expect(els.find(e => e.id === ids.f)).toMatchObject({ startBinding: null, endBinding: { elementId: ids.b } })
    await expect(run('drawing_delete', { path: 'Schémas/Plan', ids: ['inconnu'] })).rejects.toThrow('Élément introuvable')
  })

  it('drawing_diagram : des boites et des fleches attachees, places tout seuls', async () => {
    const { run, elements } = setup()
    const r = await run('drawing_diagram', {
      path: 'Schémas/Plan', direction: 'down',
      nodes: [{ key: 'q', text: 'Une question ?', shape: 'diamond' }, { key: 'oui', text: 'Faire' }, { key: 'non', text: 'Attendre' }],
      edges: [{ from: 'q', to: 'oui', text: 'oui' }, { from: 'q', to: 'non', text: 'non', style: 'dashed' }],
    })
    expect(r.text).toContain('Schéma dessiné (3 nœud(s), 2 flèche(s))')
    const ids = idsIn(r.text)
    const els = elements()
    expect(byType(els, 'arrow')).toHaveLength(2)
    expect(byType(els, 'arrow').every(a => (a.startBinding as { elementId: string }).elementId === ids.q)).toBe(true)
    const q = els.find(e => e.id === ids.q)!
    expect(els.filter(e => e.id === ids.oui || e.id === ids.non).every(e => Number(e.y) > Number(q.y) + Number(q.height))).toBe(true)
    expect(byType(els, 'arrow').find(a => a.strokeStyle === 'dashed')).toBeTruthy()
  })

  it('drawing_diagram : un aller et retour entre deux noeuds ne se recouvre pas, meme apres un deplacement', async () => {
    const { run, elements } = setup()
    const r = await run('drawing_diagram', {
      path: 'Schémas/Plan', nodes: [{ key: 'a', text: 'Plan' }, { key: 'b', text: 'Test' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a', text: 'non' }],
    })
    const ids = idsIn(r.text)
    const arrows = () => byType(elements(), 'arrow')
    const points = () => arrows().map(a => (a.points as number[][]).length).sort()
    expect(points()).toEqual([2, 3])
    const back = arrows().find(a => (a.points as number[][]).length === 3)!
    // Courbee pour Excalidraw (sinon il trace deux segments droits).
    expect(back.roundness).toEqual({ type: 2 })
    const label = elements().find(e => e.type === 'text' && e.containerId === back.id)!
    // Le texte du retour est sur sa courbe, pas sur l'aller.
    const mid = (back.points as number[][])[1]!
    expect(Number(label.y) + Number(label.height) / 2).toBeCloseTo(Number(back.y) + mid[1]!)
    await run('drawing_update', { path: 'Schémas/Plan', changes: [{ id: ids.b, dy: 150 }] })
    expect(points()).toEqual([2, 3])
  })

  it('en proposition : rien ne change, la proposition s applique a l acceptation', async () => {
    const { run, tree, elements, propose: proposeFn } = setup()
    const ids = idsIn((await run('drawing_add', { path: 'Schémas/Plan', shapes: [{ type: 'rectangle', key: 'a', x: 0, y: 0 }] })).text)
    const r = await run('drawing_update', { path: 'Schémas/Plan', changes: [{ id: ids.a, x: 50 }] }, propose)
    expect(r.text).toBe('Modification proposée (1 modifié(s)) dans Schémas/Plan.excalidraw (Révision).')
    expect(elements()[0]).toMatchObject({ x: 0 })
    expect(proposeFn).toHaveBeenCalledWith('d1', SCENE_PROPOSAL, expect.anything(), 'Dessinateur : 1 modifié(s)')
    const patch = (proposeFn.mock.calls[0] as unknown[])[2] as ScenePatch
    expect(applyScenePatch(tree('d1'), patch).conflicts).toEqual([])
    expect(elements()[0]).toMatchObject({ x: 50 })
  })

  it('drawing_create puis drawing_list', async () => {
    const { run, elements, createFile } = setup()
    const r = await run('drawing_create', { path: 'Idées/Carte', shapes: [{ type: 'text', x: 0, y: 0, text: 'Titre' }] })
    expect(createFile).toHaveBeenCalledWith('Idées/Carte.excalidraw')
    expect(r.text).toBe('Dessin créé : 1 forme(s) dans Idées/Carte.excalidraw.')
    expect(byType(elements('new-1'), 'text')).toHaveLength(1)
    await expect(run('drawing_create', { path: 'Idées/Carte.excalidraw' })).rejects.toThrow('existe déjà')
    await expect(run('drawing_create', { path: 'Autre' }, propose)).rejects.toThrow('mode proposition')
    const list = (await run('drawing_list', {})).text
    expect(list).toBe('2 dessin(s) :\n- Idées/Carte.excalidraw\n- Schémas/Plan.excalidraw')
    expect((await run('drawing_list', { folder: 'Idées' })).text).toBe('1 dessin(s) :\n- Idées/Carte.excalidraw')
  })

  it('tous les outils tournent aussi sur le pair (ChatGPT, Claude)', () => {
    const { tools } = setup()
    expect([...tools.keys()]).toEqual(['drawing_read', 'drawing_add', 'drawing_update', 'drawing_delete', 'drawing_diagram', 'drawing_create', 'drawing_list'])
    for (const t of tools.values()) expect(t.spec.runtimes).toEqual(['app', 'server'])
  })
})
