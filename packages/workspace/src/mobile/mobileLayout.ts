// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Regles de la disposition mobile, sans React : ou va chaque panneau, quelles
// vues forment un ecran, quels onglets vont dans la barre du bas.

import type { MobilePlacement, ViewGroup, ViewSpec } from '@savoire/plugin-api'
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

/** Place par defaut : le volet pour la droite, un ecran pour le reste. */
function placementOf(declared: MobilePlacement | undefined, container: string | undefined): MobilePlacement {
  return declared ?? (container === 'right' ? 'sheet' : 'tab')
}

/** Groupe visible d'une vue, ou la vue elle-meme : c'est l'ecran (ou le volet) qui l'affiche. */
function home(views: MobileViewSource, spec: ViewSpec): { id: string; placement: MobilePlacement } {
  const group = spec.groupId ? views.getGroup(spec.groupId) : undefined
  if (group) return { id: group.id, placement: placementOf(group.mobile, group.container) }
  return { id: spec.id, placement: placementOf(spec.mobile, spec.container ?? 'center') }
}

/** La place d'un panneau (vue ou groupe) sur mobile. */
export function panelPlacement(views: MobileViewSource, panelId: string): MobilePlacement {
  const group = views.getGroup(panelId)
  if (group) return placementOf(group.mobile, group.container)
  const spec = views.get(panelId)
  return spec ? home(views, spec).placement : 'tab'
}

/**
 * Ou s'affiche un panneau : le volet, ou un ecran. Un panneau cache sur
 * mobile s'ouvre quand meme en ecran si l'application le demande.
 */
export function locatePanel(views: MobileViewSource, panelId: string): MobileTarget {
  const group = views.getGroup(panelId)
  const spec = group ? undefined : views.get(panelId)
  if (!group && !spec) return { kind: 'screen', screen: panelId }
  const where = group ? { id: group.id, placement: placementOf(group.mobile, group.container) } : home(views, spec!)
  return where.placement === 'sheet' ? { kind: 'sheet', panel: where.id } : { kind: 'screen', screen: where.id }
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
    .filter(g => placementOf(g.mobile, g.container) === 'sheet')
    .map(g => ({ id: g.id, title: g.title, icon: g.icon }))
  for (const spec of views.getAll()) {
    if (spec.groupId && views.getGroup(spec.groupId)) continue
    if (placementOf(spec.mobile, spec.container ?? 'center') === 'sheet') tabs.push({ id: spec.id, title: spec.title, icon: spec.icon })
  }
  return tabs.filter(tab => panelViews(views, tab.id).length > 0)
}

/**
 * Les onglets de la barre du bas : le premier ecran (l'explorateur), la note,
 * puis les autres (`priority` d'abord). Au-dela de `max`, et ceux qui le
 * demandent (`mobile: 'more'`), ils passent dans l'ecran « Plus ». Ceux du
 * volet et ceux caches n'y sont pas.
 */
export function bottomTabs(items: RibbonItem[], editor: MobileTab, max = 3, priority: string[] = []): { primary: MobileTab[]; overflow: MobileTab[] } {
  const screenItems = items.filter(item => item.id !== EDITOR_SCREEN)
    .map(item => ({ item, placement: placementOf(item.mobile, item.container) }))
  const screens: MobileTab[] = screenItems
    .filter(x => x.placement === 'tab')
    .map(({ item }) => ({ id: item.id, title: item.title, icon: item.icon }))
  // « Plus » seulement : apres les autres, jamais dans la barre.
  const moreOnly: MobileTab[] = screenItems
    .filter(x => x.placement === 'more')
    .map(({ item }) => ({ id: item.id, title: item.title, icon: item.icon }))
  // Les onglets prioritaires passent devant les autres, le premier ecran reste en tete.
  const rank = (tab: MobileTab) => { const i = priority.indexOf(tab.id); return i === -1 ? priority.length : i }
  const rest = screens.slice(1).map((tab, i) => ({ tab, i })).sort((a, b) => rank(a.tab) - rank(b.tab) || a.i - b.i).map(x => x.tab)
  const ordered = screens.length > 0 ? [screens[0], editor, ...rest] : [editor]
  return { primary: ordered.slice(0, max), overflow: [...ordered.slice(max), ...moreOnly] }
}
