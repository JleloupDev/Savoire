// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Comparer deux etats d'un dessin (Revision) : scene proposee, differences,
// scene coloriee.
import { describe, it, expect } from 'vitest'
import { applyPatchToElements, diffSceneJson, diffScenes, parseScene, sceneJson } from '../../../../../packages/plugins/plugin-excalidraw/src/compare'

const el = (id: string, over: Record<string, unknown> = {}) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, strokeColor: '#000', version: 1, versionNonce: 1, ...over })

describe('comparaison des dessins', () => {
  const before = [el('a'), el('b'), el('c'), el('d', { type: 'text', text: 'Titre' })]

  it('applique une proposition sur la scene', () => {
    const after = applyPatchToElements(before, { elements: [el('b', { x: 50, version: 2 }), el('c', { isDeleted: true }), el('e', { type: 'ellipse' })], base: {} })
    const scene = parseScene(sceneJson(after))
    expect(scene.elements.map(e => e.id).sort()).toEqual(['a', 'b', 'd', 'e'])
    expect(scene.elements.find(e => e.id === 'b')!.x).toBe(50)
  })

  it('classe les changements : ajoute, retire, modifie, deplace', () => {
    const after = sceneJson([el('a'), el('b', { x: 40, y: 5, version: 9 }), el('d', { type: 'text', text: 'Nouveau titre' }), el('e', { type: 'ellipse' })])
    const diffs = diffScenes(sceneJson(before), after)
    const by = Object.fromEntries(diffs.map(d => [d.id, d.change]))
    expect(by).toEqual({ b: 'moved', d: 'modified', e: 'added', c: 'removed' })
    expect(diffs.find(d => d.id === 'e')!.label).toBe('Ellipse')
    expect(diffs.find(d => d.id === 'd')!.label).toContain('Nouveau titre')
  })

  it('une nouvelle version sans changement visible ne compte pas', () => {
    expect(diffScenes(sceneJson(before), sceneJson([...before.slice(0, 3), { ...before[3], version: 7, versionNonce: 99 }]))).toEqual([])
  })

  it('scene des differences : changes colories, retires en pointilles, le reste estompe', () => {
    const after = sceneJson([el('a'), el('b', { x: 40 }), el('d', { type: 'text', text: 'Titre' }), el('e')])
    const scene = parseScene(diffSceneJson(sceneJson(before), after))
    const get = (id: string) => scene.elements.find(e => e.id === id)!
    expect(get('a').opacity).toBe(25)
    expect(get('e').strokeColor).toBe('#22c55e')
    expect(get('b').strokeColor).toBe('#3b82f6')
    expect(get('c').strokeColor).toBe('#ef4444')
    expect(get('c').strokeStyle).toBe('dashed')
  })

  it('un contenu illisible donne une scene vide', () => {
    expect(parseScene('pas du json').elements).toEqual([])
  })
})
