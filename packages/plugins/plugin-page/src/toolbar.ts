// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Barre d'edition flottante des pages, facon Notion : elle apparait
// au-dessus d'une selection de texte et disparait sinon.
//
// Chaque bouton lance une commande `page:*` du moteur (runPageCommand) : la
// meme logique que la touche, rien en double. L'infobulle donne la touche en
// vigueur, celle choisie dans Parametres > Raccourcis.
//
// Elle ne prend jamais le focus : tous ses clics annulent le mousedown, la
// selection reste dans la page. Rien en lecture seule.
import type { Editor } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import type { HotkeyAPI } from '@savoire/plugin-api'
import { pageCommandLabel, runPageCommand } from './commands'
import { PAGE_COLORS } from './highlight'

interface MenuItem {
  command: string
  icon: string
  /** Bouton actif (marque ou bloc deja applique). */
  active?: (e: Editor) => boolean
}

interface ToolbarButton {
  key: string
  icon: string
  /** Commande lancee au clic ; sinon le bouton ouvre son menu. */
  command?: string
  /** Infobulle d'un bouton a menu. */
  label?: string
  active?: (e: Editor) => boolean
  items?: MenuItem[]
  /** Bouton a menu qui affiche le nom de l'element actif (type de bloc). */
  showsActive?: boolean
}

const BLOCKS: (MenuItem & { name: string })[] = [
  { command: 'page:set-paragraph', icon: '¶', name: 'Texte' },
  { command: 'page:heading-1', icon: 'H1', name: 'Titre 1', active: e => e.isActive('heading', { level: 1 }) },
  { command: 'page:heading-2', icon: 'H2', name: 'Titre 2', active: e => e.isActive('heading', { level: 2 }) },
  { command: 'page:heading-3', icon: 'H3', name: 'Titre 3', active: e => e.isActive('heading', { level: 3 }) },
  { command: 'page:toggle-bullet-list', icon: '•', name: 'Liste', active: e => e.isActive('bulletList') },
  { command: 'page:toggle-numbered-list', icon: '1.', name: 'Liste numérotée', active: e => e.isActive('orderedList') },
  { command: 'page:toggle-checklist', icon: '☐', name: 'Case à cocher', active: e => e.isActive('taskList') },
  { command: 'page:toggle-quote', icon: '❝', name: 'Citation', active: e => e.isActive('blockquote') },
]
// Texte : actif quand aucun autre ne l'est.
BLOCKS[0].active = e => !BLOCKS.slice(1).some(b => b.active!(e))

const BUTTONS: ToolbarButton[] = [
  { key: 'block', icon: 'Texte', label: 'Transformer le bloc', items: BLOCKS, showsActive: true },
  { key: 'bold', icon: 'B', command: 'page:toggle-bold', active: e => e.isActive('bold') },
  { key: 'italic', icon: 'I', command: 'page:toggle-italics', active: e => e.isActive('italic') },
  { key: 'strike', icon: 'S', command: 'page:toggle-strikethrough', active: e => e.isActive('strike') },
  { key: 'code', icon: '</>', command: 'page:toggle-code', active: e => e.isActive('code') },
  { key: 'link', icon: '🔗', command: 'page:insert-link', active: e => e.isActive('link') },
  {
    key: 'highlight', icon: '🖍', label: 'Surligner', active: e => e.isActive('highlight'),
    items: [
      { command: 'page:toggle-highlight', icon: '🖍', active: e => e.isActive('highlight', { color: null }) },
      ...PAGE_COLORS.map(c => ({
        command: `page:highlight-${c.color}`, icon: c.emoji,
        active: (e: Editor) => e.isActive('highlight', { color: c.color }),
      })),
      { command: 'page:remove-highlight', icon: '✕' },
    ],
  },
]

/** Nom d'un element de menu (« Sans couleur » pour le surlignage du theme). */
function itemLabel(item: MenuItem): string {
  if (item.command === 'page:toggle-highlight') return 'Sans couleur'
  return (item as { name?: string }).name ?? pageCommandLabel(item.command)
}

export interface SelectionToolbar {
  readonly el: HTMLElement
  /** Recalcule visibilite, etats et position. */
  update(): void
  hide(): void
  destroy(): void
}

/**
 * Cree la barre dans `host` (element en position relative qui contient
 * l'editeur). `hotkeys` sert aux infobulles ; sans lui, pas de touche.
 */
export function createSelectionToolbar(
  editor: Editor,
  host: HTMLElement,
  hotkeys?: Partial<Pick<HotkeyAPI, 'get' | 'format'>>,
): SelectionToolbar {
  const bar = document.createElement('div')
  bar.className = 'page-toolbar'
  bar.dataset.testid = 'page-toolbar'
  bar.setAttribute('role', 'toolbar')
  bar.hidden = true
  host.append(bar)

  /** Le pointeur selectionne encore : on attend qu'il lache. */
  let selecting = false
  let openMenu: string | null = null
  const refresh: (() => void)[] = []

  function title(command: string, label = pageCommandLabel(command)): string {
    const key = hotkeys?.get?.(command)?.[0]
    return key && hotkeys?.format ? `${label} (${hotkeys.format(key)})` : label
  }

  function run(command: string): void {
    openMenu = null
    runPageCommand(editor, command)
    update()
  }

  // Aucun clic dans la barre ne prend le focus.
  bar.addEventListener('mousedown', (e) => e.preventDefault())

  for (const b of BUTTONS) {
    const wrap = document.createElement('span')
    wrap.className = 'page-toolbar-group'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'page-toolbar-button'
    btn.dataset.testid = 'page-toolbar-button'
    btn.dataset.key = b.key
    if (b.command) btn.dataset.commandId = b.command
    btn.textContent = b.icon
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault()
      if (b.command) { run(b.command); return }
      openMenu = openMenu === b.key ? null : b.key
      update()
    })
    wrap.append(btn)

    let menu: HTMLElement | null = null
    if (b.items) {
      btn.classList.add('has-menu')
      btn.setAttribute('aria-haspopup', 'menu')
      menu = document.createElement('div')
      menu.className = 'page-toolbar-menu'
      menu.dataset.testid = `page-toolbar-menu-${b.key}`
      menu.setAttribute('role', 'menu')
      menu.hidden = true
      for (const item of b.items) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'page-toolbar-item'
        row.dataset.testid = 'page-toolbar-item'
        row.dataset.commandId = item.command
        row.setAttribute('role', 'menuitem')
        const icon = document.createElement('span')
        icon.className = 'page-toolbar-item-icon'
        icon.textContent = item.icon
        const name = document.createElement('span')
        name.textContent = itemLabel(item)
        row.append(icon, name)
        row.addEventListener('mousedown', (e) => {
          e.preventDefault()
          // Bloc deja de ce type : rien a transformer (un titre ne s'annule pas).
          if (b.showsActive && item.active?.(editor)) { openMenu = null; update(); return }
          run(item.command)
        })
        refresh.push(() => {
          row.title = title(item.command, itemLabel(item))
          row.classList.toggle('is-active', !!item.active?.(editor))
        })
        menu.append(row)
      }
      wrap.append(menu)
    }

    refresh.push(() => {
      const active = !!b.active?.(editor)
      btn.classList.toggle('is-active', active)
      btn.setAttribute('aria-pressed', String(active))
      btn.title = b.command ? title(b.command) : (b.label ?? '')
      if (b.showsActive && b.items) {
        const current = b.items.find(i => i.active?.(editor))
        btn.textContent = `${current ? itemLabel(current) : b.icon} ▾`
      }
      if (menu) {
        menu.hidden = openMenu !== b.key
        btn.setAttribute('aria-expanded', String(openMenu === b.key))
      }
    })
    bar.append(wrap)
  }

  function shouldShow(): boolean {
    if (editor.isDestroyed || !editor.isEditable || !editor.isFocused || selecting) return false
    const { selection } = editor.state
    if (selection.empty || selection instanceof NodeSelection) return false
    // Pas de mise en forme dans un bloc de code.
    return !(selection.$from.parent.type.spec.code || selection.$to.parent.type.spec.code)
  }

  function place(): void {
    const { from, to } = editor.state.selection
    let start: { left: number; top: number; bottom: number }
    let end: { left: number; top: number; bottom: number }
    try {
      start = editor.view.coordsAtPos(from)
      end = editor.view.coordsAtPos(to)
    } catch {
      return
    }
    const box = host.getBoundingClientRect()
    const height = bar.offsetHeight || 34
    const width = bar.offsetWidth || 0
    const sameLine = Math.abs(start.top - end.top) < 2
    const center = sameLine ? (start.left + end.left) / 2 : start.left
    const left = Math.min(Math.max(0, center - box.left - width / 2), Math.max(0, box.width - width))
    // Au-dessus de la selection ; en dessous si le haut de la vue la cache.
    const scroller = host.closest('.savoire-page')?.getBoundingClientRect()
    const above = start.top - height - 8
    const top = scroller && above < scroller.top ? end.bottom + 8 : above
    bar.style.left = `${left}px`
    bar.style.top = `${top - box.top}px`
  }

  function update(): void {
    if (!shouldShow()) { hide(); return }
    for (const r of refresh) r()
    bar.hidden = false
    place()
  }

  function hide(): void {
    openMenu = null
    bar.hidden = true
  }

  const onTransaction = () => update()
  const onBlur = () => hide()
  const onDown = (e: MouseEvent) => { if (e.button === 0) { selecting = true; hide() } }
  const onUp = () => {
    if (!selecting) return
    selecting = false
    update()
  }
  editor.on('transaction', onTransaction)
  editor.on('focus', onTransaction)
  editor.on('blur', onBlur)
  editor.view.dom.addEventListener('mousedown', onDown)
  document.addEventListener('mouseup', onUp)

  return {
    el: bar,
    update,
    hide,
    destroy() {
      editor.off('transaction', onTransaction)
      editor.off('focus', onTransaction)
      editor.off('blur', onBlur)
      editor.view.dom.removeEventListener('mousedown', onDown)
      document.removeEventListener('mouseup', onUp)
      bar.remove()
    },
  }
}
