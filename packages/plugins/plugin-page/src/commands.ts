// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Les actions clavier des pages, comme commandes du moteur de raccourcis.
//
// Regle de l'application : un plugin ne gere jamais ses raccourcis lui-meme.
// La vue passe toutes ses touches au moteur (api.hotkeys.handleKeyEvent) ;
// le moteur trouve la commande `page:*` liee a la touche. La personne voit
// et change ces touches dans Parametres > Raccourcis, comme celles de Plume,
// et les conflits y sont signales. Touches par defaut : celles de Plume.
//
// Les deux jeux ne se genent pas : les commandes `editor:*` de Plume ne
// marchent qu'avec une vue de Plume, les `page:*` qu'avec une page qui a
// le focus (isAvailable). Une commande liee a une touche sans modificateur
// (Entree, Tab, fleches) precise quand elle s'applique ; sinon la touche
// suit son cours et Tiptap fait la frappe ordinaire.
//
// Ordre : le moteur prend la premiere commande disponible. Les commandes
// du menu « / » passent donc avant Entree dans une liste.
import type { Editor } from '@tiptap/core'
import { redo, undo } from 'y-prosemirror'
import type { Hotkey, HotkeyModifier, PluginCommand } from '@savoire/plugin-api'

/** Ce que la vue d'une page offre aux commandes (menu « / », lien). */
export interface PageController {
  menuOpen(): boolean
  menuMove(step: 1 | -1): void
  menuChoose(): void
  menuClose(): void
  promptLink(): void
}

const editors = new Map<Editor, PageController | null>()

/** Declare un editeur de page ouvert. Rend la fonction qui le retire. */
export function trackPageEditor(editor: Editor, controller: PageController | null = null): () => void {
  editors.set(editor, controller)
  return () => { editors.delete(editor) }
}

/** L'editeur de page qui a le focus et accepte l'ecriture, s'il y en a un. */
export function focusedPageEditor(): Editor | null {
  for (const e of editors.keys()) if (!e.isDestroyed && e.isEditable && e.isFocused) return e
  return null
}

function focusedController(): PageController | null {
  const e = focusedPageEditor()
  return e ? editors.get(e) ?? null : null
}

/** Type d'element de liste qui contient le curseur, ou null. */
function listItemType(e: Editor): 'listItem' | 'taskItem' | null {
  const { $from } = e.state.selection
  for (let d = $from.depth; d > 0; d--) {
    const name = $from.node(d).type.name
    if (name === 'listItem' || name === 'taskItem') return name
    if (name === 'codeBlock') return null
  }
  return null
}

const mod = (key: string, ...more: HotkeyModifier[]): Hotkey[] => [{ modifiers: ['Mod', ...more], key }]
const plain = (key: string, ...modifiers: HotkeyModifier[]): Hotkey[] => [{ modifiers, key }]

interface PageAction {
  id: string
  label: string
  hotkeys?: Hotkey[]
  /** Par defaut : une page a le focus. */
  when?: (e: Editor) => boolean
  act: (e: Editor) => void
}

const inMenu = () => !!focusedController()?.menuOpen()

const ACTIONS: PageAction[] = [
  // Menu « / » : avant tout le reste (Entree, fleches).
  { id: 'page:slash-menu-next', label: 'Page : menu / — suivant', hotkeys: plain('ArrowDown'), when: inMenu, act: () => focusedController()?.menuMove(1) },
  { id: 'page:slash-menu-previous', label: 'Page : menu / — précédent', hotkeys: plain('ArrowUp'), when: inMenu, act: () => focusedController()?.menuMove(-1) },
  { id: 'page:slash-menu-choose', label: 'Page : menu / — insérer le bloc', hotkeys: [...plain('Enter'), ...plain('Tab')], when: inMenu, act: () => focusedController()?.menuChoose() },
  { id: 'page:slash-menu-close', label: 'Page : menu / — fermer', hotkeys: plain('Escape'), when: inMenu, act: () => focusedController()?.menuClose() },

  // Mise en forme : memes touches que Plume.
  { id: 'page:toggle-bold', label: 'Page : gras', hotkeys: mod('b'), act: e => { e.chain().focus().toggleBold().run() } },
  { id: 'page:toggle-italics', label: 'Page : italique', hotkeys: mod('i'), act: e => { e.chain().focus().toggleItalic().run() } },
  { id: 'page:toggle-strikethrough', label: 'Page : barré', hotkeys: mod('x', 'Shift'), act: e => { e.chain().focus().toggleStrike().run() } },
  { id: 'page:toggle-code', label: 'Page : code inline', hotkeys: mod('e'), act: e => { e.chain().focus().toggleCode().run() } },
  { id: 'page:insert-link', label: 'Page : insérer un lien', hotkeys: mod('k'), act: () => focusedController()?.promptLink() },
  { id: 'page:toggle-numbered-list', label: 'Page : liste numérotée', hotkeys: mod('7', 'Shift'), act: e => { e.chain().focus().toggleOrderedList().run() } },
  { id: 'page:toggle-bullet-list', label: 'Page : liste à puces', hotkeys: mod('8', 'Shift'), act: e => { e.chain().focus().toggleBulletList().run() } },
  { id: 'page:toggle-checklist', label: 'Page : liste de tâches', hotkeys: mod('9', 'Shift'), act: e => { e.chain().focus().toggleTaskList().run() } },
  {
    id: 'page:toggle-checklist-status', label: 'Page : cocher / décocher la case', hotkeys: mod('Enter'),
    when: e => listItemType(e) === 'taskItem',
    act: e => {
      const checked = !!e.getAttributes('taskItem').checked
      e.chain().focus().updateAttributes('taskItem', { checked: !checked }).run()
    },
  },
  { id: 'page:undo', label: 'Page : annuler', hotkeys: mod('z'), act: e => { undo(e.state) } },
  { id: 'page:redo', label: 'Page : rétablir', hotkeys: [...mod('y'), ...mod('z', 'Shift')], act: e => { redo(e.state) } },

  // Blocs : sans equivalent dans Plume, touches proches de Notion.
  { id: 'page:heading-1', label: 'Page : titre 1', hotkeys: mod('1', 'Alt'), act: e => { e.chain().focus().toggleHeading({ level: 1 }).run() } },
  { id: 'page:heading-2', label: 'Page : titre 2', hotkeys: mod('2', 'Alt'), act: e => { e.chain().focus().toggleHeading({ level: 2 }).run() } },
  { id: 'page:heading-3', label: 'Page : titre 3', hotkeys: mod('3', 'Alt'), act: e => { e.chain().focus().toggleHeading({ level: 3 }).run() } },
  { id: 'page:toggle-quote', label: 'Page : citation', hotkeys: mod('b', 'Shift'), act: e => { e.chain().focus().toggleBlockquote().run() } },
  { id: 'page:toggle-code-block', label: 'Page : bloc de code', hotkeys: mod('c', 'Alt'), act: e => { e.chain().focus().toggleCodeBlock().run() } },
  { id: 'page:hard-break', label: 'Page : retour à la ligne dans le bloc', hotkeys: plain('Enter', 'Shift'), act: e => { e.chain().focus().setHardBreak().run() } },

  // Listes : seulement quand le curseur est dans un element de liste.
  {
    id: 'page:split-list-item', label: 'Page : nouvel élément de liste', hotkeys: plain('Enter'),
    when: e => listItemType(e) !== null,
    act: e => {
      const type = listItemType(e)!
      // Element vide en haut de liste : Entree sort de la liste (comme Notion).
      if (!e.chain().focus().splitListItem(type).run()) e.chain().focus().liftListItem(type).run()
    },
  },
  {
    id: 'page:indent-list-item', label: 'Page : indenter l\'élément de liste', hotkeys: plain('Tab'),
    when: e => listItemType(e) !== null,
    act: e => { e.chain().focus().sinkListItem(listItemType(e)!).run() },
  },
  {
    id: 'page:outdent-list-item', label: 'Page : désindenter l\'élément de liste', hotkeys: plain('Tab', 'Shift'),
    when: e => listItemType(e) !== null,
    act: e => { e.chain().focus().liftListItem(listItemType(e)!).run() },
  },
]

/** Les commandes `page:*`, a enregistrer dans api.commands. */
export function pageCommands(): PluginCommand[] {
  return ACTIONS.map(a => ({
    id: a.id,
    label: a.label,
    hotkeys: a.hotkeys,
    isAvailable: () => {
      const editor = focusedPageEditor()
      return editor !== null && (a.when ? a.when(editor) : true)
    },
    run: () => {
      const editor = focusedPageEditor()
      if (editor) a.act(editor)
    },
  }))
}
