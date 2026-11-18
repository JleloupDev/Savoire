// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Regles de la disposition mobile, sans React : ou va chaque panneau, quelles
// vues forment un ecran, quels onglets vont dans la barre du bas.

import type { ViewGroup, ViewSpec } from '@savoire/plugin-api'
import type { RibbonItem } from '../WorkspaceManagerImpl'
import { EDITOR_SCREEN } from './MobileAdapter'
import type { MobileTarget } from './MobileAdapter'

/** Ce que la disposition mobile lit des vues enregistrees. */
export interface MobileViewSource {
  get(id: string): ViewSpec | undefined
  getAll(): ViewSpec[]
  getGroup(id: string): ViewGroup | undefined
  getGroups(): ViewGroup[]
}

/** Un onglet de la barre du bas (ou de l'ecran « Plus »). */
export interface MobileTab {
  id: string
  title: string
  icon?: string
}

/** Groupe visible d'une vue, ou la vue elle-meme : c'est l'ecran (ou le volet) qui l'affiche. */
function home(views: MobileViewSource, spec: ViewSpec): { id: string; container: string } {
  const group = spec.groupId ? views.getGroup(spec.groupId) : undefined
  if (group) return { id: group.id, container: group.container }
  return { id: spec.id, container: spec.container ?? 'center' }
}

/** Ou s'affiche un panneau : la droite va dans le volet, le reste en ecran. */
export function locatePanel(views: MobileViewSource, panelId: string): MobileTarget {
  const group = views.getGroup(panelId)
  if (group) return group.container === 'right' ? { kind: 'sheet', panel: group.id } : { kind: 'screen', screen: group.id }
  const spec = views.get(panelId)
  if (!spec) return { kind: 'screen', screen: panelId }
  const where = home(views, spec)
  return where.container === 'right' ? { kind: 'sheet', panel: where.id } : { kind: 'screen', screen: where.id }
}

/**
 * Les vues d'un ecran (ou d'un onglet du volet), dans l'ordre : celles du
 * groupe, ou la vue seule. Vide si le panneau n'existe plus.
 */
export function panelViews(views: MobileViewSource, panelId: string): ViewSpec[] {
  if (views.getGroup(panelId)) {
    const members = views.getAll().filter(v => v.groupId === panelId)
    // Une vue posee sous une autre (belowOf) vient apres elle.
    const ordered: ViewSpec[] = []
    const pending = [...members]
    while (pending.length > 0) {
      const i = pending.findIndex(v => !v.belowOf || !pending.some(o => o.id === v.belowOf))
      ordered.push(...pending.splice(i === -1 ? 0 : i, 1))
    }
    return ordered
  }
  const spec = views.get(panelId)
  return spec ? [spec] : []
}

/** Les onglets du volet : groupes et vues de droite. */
export function sheetTabs(views: MobileViewSource): MobileTab[] {
  const tabs: MobileTab[] = views.getGroups()
    .filter(g => g.container === 'right')
    .map(g => ({ id: g.id, title: g.title, icon: g.icon }))
  for (const spec of views.getAll()) {
    if (spec.groupId && views.getGroup(spec.groupId)) continue
    if (spec.container === 'right') tabs.push({ id: spec.id, title: spec.title, icon: spec.icon })
  }
  return tabs.filter(tab => panelViews(views, tab.id).length > 0)
}

/**
 * Les onglets de la barre du bas : le premier ecran (l'explorateur), la note,
 * puis les autres (`priority` d'abord). Au-dela de `max`, ils passent dans
 * l'ecran « Plus ».
 */
export function bottomTabs(items: RibbonItem[], editor: MobileTab, max = 3, priority: string[] = []): { primary: MobileTab[]; overflow: MobileTab[] } {
  const screens: MobileTab[] = items
    .filter(item => item.container !== 'right' && item.id !== EDITOR_SCREEN)
    .map(item => ({ id: item.id, title: item.title, icon: item.icon }))
  // Les onglets prioritaires passent devant les autres, le premier ecran reste en tete.
  const rank = (tab: MobileTab) => { const i = priority.indexOf(tab.id); return i === -1 ? priority.length : i }
  const rest = screens.slice(1).map((tab, i) => ({ tab, i })).sort((a, b) => rank(a.tab) - rank(b.tab) || a.i - b.i).map(x => x.tab)
  const ordered = screens.length > 0 ? [screens[0], editor, ...rest] : [editor]
  return { primary: ordered.slice(0, max), overflow: ordered.slice(max) }
}
