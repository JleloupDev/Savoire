// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Propositions des plugins (Revision, mode suggestion) : ce que chaque type
// applique a l'acceptation, et son refus quand le document a change depuis.
//  - dessin : des elements changes, ecrits dans l'arbre de la scene ;
//  - base : une valeur de cellule d'une ligne-page (frontmatter).
import { describe, it, expect, vi } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { PluginAPI, VaultAPI } from '@savoire/plugin-api'
import {
  SceneBinding, applyScenePatch, type SceneElement,
} from '../../../../../packages/plugins/plugin-excalidraw/src/binding'
import { cellProposalType, type CellProposal } from '../../../../../packages/plugins/plugin-base/src/proposals'

/** Une vue de dessin sur un arbre : un tableau d'elements, comme Excalidraw. */
function drawing(tree: InMemorySharedTree) {
  let elements: SceneElement[] = []
  const binding = new SceneBinding({
    tree, getElements: () => elements, applyElements: els => { elements = els },
    hasFile: () => false, addFiles: () => {}, throttleMs: 1,
  })
  binding.start()
  const edit = (id: string, props: Partial<SceneElement> = {}) => {
    const prev = elements.find(e => e.id === id) ?? { id, version: 0, versionNonce: 0, type: 'rectangle', x: 0 }
    const next = { ...prev, ...props, version: prev.version + 1, versionNonce: Math.floor(Math.random() * 1e9) }
    elements = elements.some(e => e.id === id) ? elements.map(e => (e.id === id ? next : e)) : [...elements, next]
    binding.localChange()
  }
  return { binding, edit, elements: () => elements }
}

const wait = () => new Promise(r => setTimeout(r, 10))

describe('proposition de dessin', () => {
  it('en mode suggestion rien n\'est ecrit ; la proposition, acceptee, ecrit les changements', async () => {
    const tree = new InMemorySharedTree()
    const view = drawing(tree)
    view.edit('a', { x: 1 })
    await wait()
    view.binding.setWritable(false) // mode suggestion
    view.edit('a', { x: 50 })
    view.edit('b', { x: 9 })
    await wait()
    expect(view.binding.readElements().map(e => [e.id, e.x])).toEqual([['a', 1]])

    const patch = view.binding.pendingChanges()
    expect(patch.elements.map(e => e.id).sort()).toEqual(['a', 'b'])
    expect(patch.base.b).toBeNull()

    expect(applyScenePatch(tree, patch)).toEqual({ conflicts: [] })
    const after = view.binding.readElements()
    expect(after.map(e => [e.id, e.x])).toEqual([['a', 50], ['b', 9]])
    // Les elements appliques ont une version plus haute : ils gagnent la fusion partout.
    expect(after.find(e => e.id === 'a')!.version).toBeGreaterThan(patch.elements.find(e => e.id === 'a')!.version)
  })

  it('refusee si un element a change depuis la proposition', async () => {
    const tree = new InMemorySharedTree()
    const other = new InMemorySharedTree()
    InMemorySharedTree.link(tree, other)
    const mine = drawing(tree)
    const theirs = drawing(other)
    mine.edit('a', { x: 1 })
    await wait()
    mine.binding.setWritable(false)
    mine.edit('a', { x: 2 })
    const patch = mine.binding.pendingChanges()
    theirs.edit('a', { x: 99 })
    await wait()
    expect(applyScenePatch(tree, patch).conflicts).toEqual(['a'])
    expect(mine.binding.readElements()[0].x).toBe(99)
  })
})

describe('proposition de cellule de base', () => {
  function vaultWith(text: string) {
    const note = { text }
    const editText = vi.fn(async (_id: string, fn: (s: string) => string) => { note.text = fn(note.text); return true })
    const vault = { read: async () => note.text, editText, resolveDocumentId: () => 'n1' } as unknown as VaultAPI
    return { note, api: { vault } as unknown as PluginAPI }
  }
  const proposal: CellProposal = { row: { kind: 'page', docId: 'n1' }, title: 'Tache', key: 'statut', before: 'En cours', after: 'Fait' }

  it('se decrit, et s\'applique au frontmatter de la ligne-page', async () => {
    const { note, api } = vaultWith('---\nstatut: En cours\n---\nCorps\n')
    const spec = cellProposalType(api)
    expect(spec.describe(proposal)).toBe('Tache · statut : En cours → Fait')
    await spec.apply('base1', proposal)
    expect(note.text).toContain('statut: Fait')
    expect(note.text).toContain('Corps')
  })

  it('refusee si la cellule a change depuis', async () => {
    const { note, api } = vaultWith('---\nstatut: Bloque\n---\n')
    await expect(cellProposalType(api).apply('base1', proposal)).rejects.toThrow(/a changé/)
    expect(note.text).toContain('statut: Bloque')
  })

  it('un nouveau nom de ligne-page renomme sa note ; refuse si elle a bouge', async () => {
    const { api } = vaultWith('')
    const moveFiles = vi.fn(async () => {})
    Object.assign(api.vault, { resolveDocumentId: (p: string) => p === 'Taches/Tache.md' ? 'n1' : undefined, renameFile: async () => {}, moveFiles })
    const rename: CellProposal = { row: { kind: 'page', docId: 'n1', path: 'Taches/Tache.md' }, title: 'Tache', key: '@title', before: 'Tache', after: 'Tache urgente' }
    const spec = cellProposalType(api)
    expect(spec.describe(rename)).toBe('Tache · Nom : Tache → Tache urgente')
    await spec.apply('base1', rename)
    expect(moveFiles).toHaveBeenCalledWith([{ from: 'Taches/Tache.md', to: 'Taches/Tache urgente.md' }])
    await expect(spec.apply('base1', { ...rename, row: { kind: 'page', docId: 'n1', path: 'Ailleurs.md' } })).rejects.toThrow(/renommée ou déplacée/)
  })
})
