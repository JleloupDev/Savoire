// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent d'Excalidraw (ADR-033) : lire la scene, ajouter des formes
// (en direct dans l'arbre, ou en proposition « excalidraw.scene »).
import { describe, it, expect, vi } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { PluginAPI, ToolContext } from '@savoire/plugin-api'
import { SCENE_PROPOSAL, describeScene, excalidrawAgentTools, shapeElements } from '../../../../../packages/plugins/plugin-excalidraw/src/agentTools'
import { SceneBinding, applyScenePatch, type ScenePatch } from '../../../../../packages/plugins/plugin-excalidraw/src/binding'

const actor = { agentId: 'a', agentName: 'Dessinateur', onBehalfOf: { userId: 'u', displayName: 'Jean' } }

function setup() {
  const tree = new InMemorySharedTree()
  const propose = vi.fn(async () => 'p1')
  const api = {
    vault: {
      getFileTree: () => [{ docId: 'd1', path: 'Schémas/Plan.excalidraw' }],
      resolveDocumentId: () => undefined,
      openTree: async () => tree,
      closeTree: () => {},
    },
    review: { propose },
  } as unknown as PluginAPI
  const [read, add] = excalidrawAgentTools(api)
  const elements = () => new SceneBinding({ tree, getElements: () => null, applyElements: () => {}, hasFile: () => false, addFiles: () => {} }).readElements()
  return { read: read!, add: add!, tree, propose, elements }
}

describe('excalidraw : outils d agent', () => {
  it('une forme avec texte donne la forme et son etiquette liee', () => {
    const [box, label] = shapeElements({ type: 'rectangle', x: 0, y: 0, width: 100, height: 50, text: 'Début' })
    expect(box).toMatchObject({ type: 'rectangle', boundElements: [{ type: 'text', id: label!.id }] })
    expect(label).toMatchObject({ type: 'text', text: 'Début', containerId: box!.id, textAlign: 'center' })
    expect(shapeElements({ type: 'arrow', x: 10, y: 10, width: 90, height: 0 })[0]).toMatchObject({ points: [[0, 0], [90, 0]], endArrowhead: 'arrow' })
  })

  it('ajoute des formes en direct, puis les relit', async () => {
    const { read, add, elements } = setup()
    const r = await add.run({ path: 'Schémas/Plan', shapes: [
      { type: 'rectangle', x: 0, y: 0, width: 120, height: 60, text: 'Idée' },
      { type: 'arrow', x: 120, y: 30, width: 80, height: 0 },
      { type: 'text', x: 0, y: 100, text: 'Note libre' },
    ] }, { mode: 'direct', actor } as ToolContext)
    expect(r.text).toBe('3 forme(s) ajoutée(s) à Schémas/Plan.excalidraw.')
    expect(elements().map(e => String(e.type)).sort()).toEqual(['arrow', 'rectangle', 'text', 'text'])
    const text = (await read.run({ path: 'Schémas/Plan.excalidraw' }, { mode: 'direct', actor } as ToolContext)).text
    expect(text).toContain('3 élément(s)')
    expect(text).toMatch(/- rectangle \S+ à \(0, 0\), 120×60 : « Idée »/)
    expect(text).toContain('« Note libre »')
  })

  it('en proposition : rien ne change, la proposition s applique a l acceptation', async () => {
    const { add, tree, propose, elements } = setup()
    await add.run({ path: 'Schémas/Plan', shapes: [{ type: 'ellipse', x: 5, y: 5 }] }, { mode: 'propose', actor } as ToolContext)
    expect(elements()).toEqual([])
    expect(propose).toHaveBeenCalledWith('d1', SCENE_PROPOSAL, expect.anything(), 'Dessinateur : 1 forme(s)')
    const patch = (propose.mock.calls[0] as unknown[])[2] as ScenePatch
    expect(applyScenePatch(tree, patch).conflicts).toEqual([])
    expect(describeScene(elements())).toContain('ellipse')
  })

  it('refuse une forme mal decrite', async () => {
    const { add } = setup()
    await expect(add.run({ path: 'Schémas/Plan', shapes: [{ type: 'etoile', x: 0, y: 0 }] }, { mode: 'direct', actor } as ToolContext)).rejects.toThrow('type parmi')
    await expect(add.run({ path: 'Autre', shapes: [{ type: 'text', x: 0, y: 0 }] }, { mode: 'direct', actor } as ToolContext)).rejects.toThrow('Dessin introuvable')
  })
})
