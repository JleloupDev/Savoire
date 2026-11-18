// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Disposition mobile : un ecran a la fois, un volet du bas, un historique.
import { describe, it, expect, vi } from 'vitest'
import { MobileAdapter, EDITOR_SCREEN, WorkspaceManagerImpl, ViewRegistryImpl, locatePanel, panelViews, sheetTabs, bottomTabs } from '@savoire/workspace'
import type { ViewSpec } from '@savoire/plugin-api'
import type { RibbonItem } from '@savoire/workspace'

const view = (spec: Partial<ViewSpec> & { id: string }): ViewSpec =>
  ({ title: spec.id, createView: () => ({ render: () => null }), ...spec }) as ViewSpec

function registry(): ViewRegistryImpl {
  const views = new ViewRegistryImpl()
  views.register(view({ id: 'editor-area', container: 'center' }))
  views.registerGroup({ id: 'explorer', title: 'Explorateur', container: 'left', layout: 'stack' })
  views.registerGroup({ id: 'notes-tools', title: 'Notes', container: 'right', layout: 'stack' })
  views.register(view({ id: 'filetree', groupId: 'explorer', belowOf: 'vault-browser' }))
  views.register(view({ id: 'vault-browser', groupId: 'explorer' }))
  views.register(view({ id: 'backlinks', groupId: 'notes-tools' }))
  views.register(view({ id: 'search', container: 'left' }))
  views.register(view({ id: 'review', container: 'right' }))
  views.register(view({ id: 'graph', container: 'center' }))
  return views
}

describe('MobileAdapter', () => {
  it("demarre sur l'editeur, sans retour possible", () => {
    const a = new MobileAdapter()
    expect(a.screen).toBe(EDITOR_SCREEN)
    expect(a.canGoBack()).toBe(false)
    expect(a.back()).toBe(false)
  })

  it('ouvre des ecrans et revient en arriere', () => {
    const a = new MobileAdapter()
    const pushed = vi.fn()
    a.subscribePush(pushed)
    a.navigate('explorer')
    a.navigate(EDITOR_SCREEN)
    expect(pushed).toHaveBeenCalledTimes(2)
    expect(a.back()).toBe(true)
    expect(a.screen).toBe('explorer')
    a.navigate('explorer')
    expect(pushed).toHaveBeenCalledTimes(2)
  })

  it("retour ferme d'abord le volet", () => {
    const a = new MobileAdapter()
    a.navigate('explorer')
    a.openSheet('notes-tools')
    a.openSheet('review')
    expect(a.activePanel()).toBe('review')
    a.back()
    expect(a.sheetPanel).toBeNull()
    expect(a.screen).toBe('explorer')
  })

  it("ouvrir un fichier mene a l'editeur ; le focus d'une vue de droite ouvre le volet", async () => {
    const a = new MobileAdapter()
    const m = new WorkspaceManagerImpl(a)
    const views = registry()
    a.setLocator(id => locatePanel(views, id))
    a.navigate('explorer')
    await m.openFile('notes/a.md')
    expect(a.screen).toBe(EDITOR_SCREEN)
    m.focusPanel('backlinks')
    expect(a.sheetPanel).toBe('notes-tools')
    m.focusPanel('search')
    expect(a.screen).toBe('search')
    expect(a.sheetPanel).toBeNull()
  })

  it('un panneau ferme quitte l\'historique', () => {
    const a = new MobileAdapter()
    a.navigate('search')
    a.navigate('graph')
    a.closePanel('graph')
    expect(a.screen).toBe('search')
  })
})

describe('regles de la disposition mobile', () => {
  it('range chaque panneau a sa place', () => {
    const views = registry()
    expect(locatePanel(views, 'filetree')).toEqual({ kind: 'screen', screen: 'explorer' })
    expect(locatePanel(views, 'review')).toEqual({ kind: 'sheet', panel: 'review' })
    expect(locatePanel(views, 'graph')).toEqual({ kind: 'screen', screen: 'graph' })
  })

  it("garde l'ordre d'un groupe empile", () => {
    expect(panelViews(registry(), 'explorer').map(v => v.id)).toEqual(['vault-browser', 'filetree'])
  })

  it('le volet reunit les groupes et vues de droite', () => {
    expect(sheetTabs(registry()).map(t => t.id)).toEqual(['notes-tools', 'review'])
  })

  it('la barre du bas : explorateur, note, puis les autres', () => {
    const items: RibbonItem[] = [
      { type: 'group', id: 'explorer', title: 'Explorateur', container: 'left' },
      { type: 'view', id: 'search', title: 'Recherche', container: 'left' },
      { type: 'view', id: 'graph', title: 'Graphe', container: 'center' },
      { type: 'view', id: 'review', title: 'Révision', container: 'right' },
    ]
    const { primary, overflow } = bottomTabs(items, { id: EDITOR_SCREEN, title: 'Note' })
    expect(primary.map(t => t.id)).toEqual(['explorer', EDITOR_SCREEN, 'search'])
    expect(overflow.map(t => t.id)).toEqual(['graph'])
  })
})
