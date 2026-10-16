// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les actions clavier des cartes mentales, comme commandes du moteur de
// raccourcis. La vue ne gere aucune touche : elle les passe toutes au
// moteur, qui trouve la commande `mindmap:*` liee. Chaque touche se change
// dans Parametres > Raccourcis.
//
// Touches par defaut : celles de mind-elixir. Une commande n'est disponible
// que si une carte a le focus (et, pour la plupart, un noeud selectionne) :
// sinon la touche suit son cours normal.
import type { Hotkey, HotkeyModifier, PluginCommand } from '@savoire/plugin-api'
import type { MindElixirInstance } from 'mind-elixir'
import { focusedMindmap, type MindmapEditor } from './view'

const hk = (key: string, ...modifiers: HotkeyModifier[]): Hotkey => ({ modifiers, key })

type Topic = NonNullable<MindElixirInstance['currentNode']>

function selected(me: MindElixirInstance): Topic | null {
  return me.currentNode ?? me.currentNodes?.[0] ?? null
}

function find(me: MindElixirInstance, id: string): Topic | null {
  try { return me.findEle(id, me) } catch { return null }
}

/** Selectionne sans faire defiler plus que necessaire. */
function select(me: MindElixirInstance, el: Topic | null): void {
  if (el) me.selectNode(el)
}

/** Cote du noeud : 'lhs' ou 'rhs' (null pour la racine). */
function sideOf(el: Topic): 'lhs' | 'rhs' | null {
  const main = el.closest('me-main')
  if (!main) return null
  return main.classList.contains('lhs') ? 'lhs' : 'rhs'
}

/** Frere precedent ou suivant (meme cote, comme mind-elixir). */
function sibling(me: MindElixirInstance, dir: -1 | 1): void {
  const el = selected(me)
  if (!el || !el.nodeObj.parent) return
  // me-tpc > me-parent > me-wrapper : on passe au wrapper voisin.
  const wrapper = el.parentElement?.parentElement
  const next = (dir < 0 ? wrapper?.previousElementSibling : wrapper?.nextElementSibling) as HTMLElement | null
  const tpc = next?.querySelector(':scope > me-parent > me-tpc') as Topic | null
  select(me, tpc)
}

/** Gauche / droite : vers le parent ou le premier enfant, selon le cote. */
function horizontal(me: MindElixirInstance, dir: 'lhs' | 'rhs'): void {
  const el = selected(me)
  if (!el) return
  const node = el.nodeObj
  const side = sideOf(el)
  if (side === null) {
    // Racine : premier enfant de ce cote.
    const tpc = me.map.querySelector(`me-main.${dir} > me-wrapper > me-parent > me-tpc`) as Topic | null
    select(me, tpc)
    return
  }
  if (side === dir) {
    const first = node.children?.[0]
    if (first && node.expanded !== false) select(me, find(me, first.id))
  } else if (node.parent) {
    select(me, find(me, node.parent.id))
  }
}

function removeSelection(me: MindElixirInstance): void {
  if (me.currentArrow) me.removeArrow()
  else if (me.currentSummary) me.removeSummary(me.currentSummary.summaryObj.id)
  else if (me.currentNodes?.length) void me.removeNodes(me.currentNodes)
  else if (me.currentNode?.nodeObj.parent) void me.removeNode()
}

interface MindmapAction {
  id: string
  label: string
  hotkeys?: Hotkey[]
  /** Ne s'applique qu'en ecriture. */
  edit?: boolean
  available?: (me: MindElixirInstance) => boolean
  run: (me: MindElixirInstance, ed: MindmapEditor) => void
}

const hasNode = (me: MindElixirInstance) => !!me.currentNode
const notRoot = (me: MindElixirInstance) => !!me.currentNode?.nodeObj.parent

export const MINDMAP_ACTIONS: MindmapAction[] = [
  { id: 'mindmap:add-child', label: 'Carte mentale : ajouter un enfant', hotkeys: [hk('Tab')], edit: true,
    available: hasNode, run: me => { void me.addChild() } },
  { id: 'mindmap:add-sibling', label: 'Carte mentale : ajouter un frère après', hotkeys: [hk('Enter')], edit: true,
    available: hasNode, run: me => { void me.insertSibling('after') } },
  { id: 'mindmap:add-sibling-before', label: 'Carte mentale : ajouter un frère avant', hotkeys: [hk('Enter', 'Shift')], edit: true,
    available: notRoot, run: me => { void me.insertSibling('before') } },
  { id: 'mindmap:add-parent', label: 'Carte mentale : insérer un parent', hotkeys: [hk('Enter', 'Mod')], edit: true,
    available: notRoot, run: me => { void me.insertParent() } },
  { id: 'mindmap:delete', label: 'Carte mentale : supprimer la sélection', hotkeys: [hk('Delete'), hk('Backspace')], edit: true,
    available: me => !!(me.currentArrow || me.currentSummary || me.currentNodes?.length || me.currentNode?.nodeObj.parent),
    run: removeSelection },
  { id: 'mindmap:edit', label: 'Carte mentale : modifier le titre', hotkeys: [hk('F2')], edit: true,
    available: hasNode, run: me => { void me.beginEdit() } },
  { id: 'mindmap:move-up', label: 'Carte mentale : monter le nœud', hotkeys: [hk('ArrowUp', 'Alt'), hk('PageUp')], edit: true,
    available: notRoot, run: me => { void me.moveUpNode() } },
  { id: 'mindmap:move-down', label: 'Carte mentale : descendre le nœud', hotkeys: [hk('ArrowDown', 'Alt'), hk('PageDown')], edit: true,
    available: notRoot, run: me => { void me.moveDownNode() } },
  { id: 'mindmap:copy', label: 'Carte mentale : copier les nœuds', hotkeys: [hk('c', 'Mod')],
    available: me => !!(me.currentNode || me.currentNodes?.length),
    run: me => { me.waitCopy = me.currentNode ? [me.currentNode] : me.currentNodes } },
  { id: 'mindmap:cut', label: 'Carte mentale : couper les nœuds', hotkeys: [hk('x', 'Mod')], edit: true,
    available: me => !!(me.currentNodes?.length || me.currentNode?.nodeObj.parent),
    run: me => { me.waitCopy = me.currentNode ? [me.currentNode] : me.currentNodes; removeSelection(me) } },
  { id: 'mindmap:paste', label: 'Carte mentale : coller sous le nœud', hotkeys: [hk('v', 'Mod')], edit: true,
    available: me => !!(me.waitCopy?.length && me.currentNode),
    run: me => {
      const from = me.waitCopy ?? []
      if (!me.currentNode) return
      if (from.length === 1) void me.copyNode(from[0], me.currentNode)
      else void me.copyNodes(from, me.currentNode)
    } },
  { id: 'mindmap:select-previous', label: 'Carte mentale : nœud précédent', hotkeys: [hk('ArrowUp')],
    available: hasNode, run: me => sibling(me, -1) },
  { id: 'mindmap:select-next', label: 'Carte mentale : nœud suivant', hotkeys: [hk('ArrowDown')],
    available: hasNode, run: me => sibling(me, 1) },
  { id: 'mindmap:select-left', label: 'Carte mentale : nœud à gauche', hotkeys: [hk('ArrowLeft')],
    available: hasNode, run: me => horizontal(me, 'lhs') },
  { id: 'mindmap:select-right', label: 'Carte mentale : nœud à droite', hotkeys: [hk('ArrowRight')],
    available: hasNode, run: me => horizontal(me, 'rhs') },
  { id: 'mindmap:center', label: 'Carte mentale : recentrer', hotkeys: [hk('F1')],
    run: me => me.toCenter() },
  { id: 'mindmap:layout-left', label: 'Carte mentale : branches à gauche', hotkeys: [hk('ArrowLeft', 'Mod')],
    run: me => me.initLeft() },
  { id: 'mindmap:layout-right', label: 'Carte mentale : branches à droite', hotkeys: [hk('ArrowRight', 'Mod')],
    run: me => me.initRight() },
  { id: 'mindmap:layout-side', label: 'Carte mentale : branches des deux côtés', hotkeys: [hk('ArrowUp', 'Mod')],
    run: me => me.initSide() },
  { id: 'mindmap:zoom-in', label: 'Carte mentale : zoom avant', hotkeys: [hk('=', 'Mod'), hk('+', 'Mod')],
    run: (_me, ed) => ed.zoom(1) },
  { id: 'mindmap:zoom-out', label: 'Carte mentale : zoom arrière', hotkeys: [hk('-', 'Mod')],
    run: (_me, ed) => ed.zoom(-1) },
  { id: 'mindmap:zoom-reset', label: 'Carte mentale : zoom 100 %', hotkeys: [hk('0', 'Mod')],
    run: (_me, ed) => ed.zoom(0) },
]

/** Commandes du moteur, disponibles seulement quand une carte a le focus. */
export function mindmapCommands(): PluginCommand[] {
  return MINDMAP_ACTIONS.map(a => ({
    id: a.id,
    label: a.label,
    hotkeys: a.hotkeys,
    isAvailable: () => {
      const ed = focusedMindmap()
      if (!ed) return false
      if (a.edit && ed.isReadOnly()) return false
      return a.available ? a.available(ed.me) : true
    },
    run: () => {
      const ed = focusedMindmap()
      if (ed) a.run(ed.me, ed)
    },
  }))
}
