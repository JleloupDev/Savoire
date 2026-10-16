// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// La vue d'une page .page : un editeur de blocs facon Notion (Tiptap).
//
// Le titre affiche en haut est le NOM DU FICHIER, pas un bloc du contenu :
// c'est lui que visent les liens [[Projet/Nom]], l'arborescence et les
// onglets. Un seul endroit pour le titre, rien a garder en coherence. On le
// change en renommant le fichier.
//
// Contenu : Tiptap <-> Y.Doc prive (y-prosemirror) <-> stockage. Le stockage
// est l'arbre partage du document (ctx.tree) s'il y en a un ; sinon le
// fichier JSON, lu et ecrit via ctx.vault (mode local).
import { Editor, Extension } from '@tiptap/core'
import { NodeSelection } from '@tiptap/pm/state'
import * as Y from 'yjs'
import { ySyncPlugin, yUndoPlugin } from 'y-prosemirror'
import type { FileContext, FileView, HotkeyAPI, VaultAPI, WorkspaceAPI } from '@savoire/plugin-api'
import { PAGE_EDITOR_OPTIONS, pageExtensions, PageLink, pageLinkLabel } from './schema'
import { filterBlocks, matchSlash, type BlockItem } from './blocks'
import { trackPageEditor, type PageController } from './commands'
import { PAGE_FRAGMENT } from './adapter/convert'
import { TreeMirror } from './adapter/TreeMirror'
import { VaultMirror } from './adapter/VaultMirror'
import { PageFileError } from './adapter/pageFile'
import { linkTargetOf, resolveLinkTarget, subPageFolder, subPagePath } from './subpage'
import { PAGE_CSS } from './style'

export interface PageViewDeps {
  workspace?: Pick<WorkspaceAPI, 'openFile'>
  /** Vault de l'application : creation des sous-pages, existence des cibles. */
  vault?: VaultAPI
  /**
   * Moteur de raccourcis : la vue lui passe TOUTES ses touches. Sans lui,
   * aucune action clavier (seule la frappe ordinaire marche).
   */
  hotkeys?: Pick<HotkeyAPI, 'handleKeyEvent'>
}

/** Editeur d'une vue montee, par conteneur (tests, outils). */
const editorsByContainer = new WeakMap<HTMLElement, Editor>()

export function pageEditorOf(container: HTMLElement): Editor | undefined {
  return editorsByContainer.get(container)
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/**
 * Lien Tiptap <-> Y.Doc prive, et son historique (Annuler / Retablir : les
 * commandes page:undo et page:redo). Il n'annule que les gestes de cette
 * vue, jamais ceux des autres membres.
 */
function privateYSync(fragment: Y.XmlFragment): Extension {
  return Extension.create({
    name: 'pagePrivateYSync',
    addProseMirrorPlugins() {
      return [ySyncPlugin(fragment), yUndoPlugin()]
    },
  })
}

export function createPageView(path: string, ctx: FileContext, deps: PageViewDeps = {}): FileView {
  const vault = ctx.vault ?? deps.vault
  const ydoc = new Y.Doc()
  const fragment = ydoc.getXmlFragment(PAGE_FRAGMENT)
  let editor: Editor | null = null
  let root: HTMLElement | null = null
  let status: HTMLElement | null = null
  let readOnly = !!ctx.readOnly
  /** Lecture seule imposee par la vue (fichier illisible, pas de stockage). */
  let forcedReadOnly = false
  let treeMirror: TreeMirror | null = null
  let vaultMirror: VaultMirror | null = null
  let destroyed = false
  const cleanups: (() => void)[] = []

  const fileName = path.split('/').at(-1)?.replace(/\.page$/i, '') ?? path

  function setStatus(text: string, kind: 'info' | 'error' = 'info'): void {
    if (!status) return
    status.textContent = text
    status.dataset.kind = kind
    status.hidden = !text
  }

  function applyEditable(): void {
    const editable = !readOnly && !forcedReadOnly
    editor?.setEditable(editable)
    root?.classList.toggle('is-readonly', !editable)
  }

  function exists(p: string): boolean {
    return !!vault?.resolveDocumentId(p)
  }

  function openTarget(target: string): void {
    const file = resolveLinkTarget(target, exists)
    void deps.workspace?.openFile(file)
  }

  // ── Bloc sous-page : une carte cliquable ─────────────────────────────

  const PageLinkCard = PageLink.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = el('div', 'page-link-card')
        dom.dataset.testid = 'page-link-card'
        dom.dataset.target = String(node.attrs.target)
        dom.contentEditable = 'false'
        dom.append(el('span', 'page-link-icon', '📄'), el('span', 'page-link-label', pageLinkLabel(String(node.attrs.target))))
        dom.addEventListener('click', (e) => {
          e.preventDefault()
          openTarget(String(node.attrs.target))
        })
        return { dom }
      }
    },
  })

  async function createSubPage(name: string): Promise<string | null> {
    if (!vault?.createFile) {
      setStatus('Impossible de créer une sous-page ici.', 'error')
      return null
    }
    const folder = subPageFolder(path)
    const existing = new Set(await vault.list(folder).catch(() => [] as string[]))
    const subPath = subPagePath(path, name, existing)
    await vault.createFile(subPath)
    return linkTargetOf(subPath)
  }

  // ── Menu « / » ───────────────────────────────────────────────────────

  const menu = {
    el: null as HTMLElement | null,
    open: false,
    items: [] as BlockItem[],
    index: 0,
    /** Position du « / » dans le document. */
    from: 0,
    /** Position du « / » fermee avec Echap : on ne rouvre pas dessus. */
    dismissedAt: -1,
    naming: false,
  }

  function closeMenu(): void {
    menu.open = false
    menu.naming = false
    if (menu.el) menu.el.hidden = true
  }

  function renderMenu(): void {
    if (!menu.el || !editor) return
    const list = menu.el
    list.replaceChildren()
    if (!menu.items.length) {
      list.append(el('div', 'page-menu-empty', 'Aucun bloc'))
    }
    menu.items.forEach((item, i) => {
      const row = el('div', 'page-menu-item')
      row.dataset.testid = `page-slash-${item.id}`
      if (i === menu.index) row.classList.add('is-active')
      row.append(el('span', 'page-menu-icon', item.icon), el('span', '', item.label))
      row.addEventListener('mousedown', (e) => {
        e.preventDefault()
        choose(item)
      })
      list.append(row)
    })
    const coords = editor.view.coordsAtPos(menu.from)
    const box = root!.querySelector<HTMLElement>('.page-body')!.getBoundingClientRect()
    list.style.left = `${Math.max(0, coords.left - box.left)}px`
    list.style.top = `${coords.bottom - box.top + 4}px`
    list.hidden = false
  }

  function updateMenu(): void {
    if (!editor || menu.naming) return
    const { state } = editor
    const { selection } = state
    const $from = selection.$from
    if (!editor.isEditable || !selection.empty || !$from.parent.isTextblock || $from.parent.type.name === 'codeBlock') {
      closeMenu()
      return
    }
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    const m = matchSlash(before)
    if (!m) { closeMenu(); menu.dismissedAt = -1; return }
    const from = $from.start() + m.offset
    if (from === menu.dismissedAt) { closeMenu(); return }
    const items = filterBlocks(m.query)
    if (!menu.open || from !== menu.from) menu.index = 0
    menu.open = true
    menu.from = from
    menu.items = items
    menu.index = Math.min(menu.index, Math.max(0, items.length - 1))
    renderMenu()
  }

  function choose(item: BlockItem): void {
    if (!editor) return
    const to = editor.state.selection.from
    editor.chain().focus().deleteRange({ from: menu.from, to }).run()
    if (item.apply) {
      closeMenu()
      item.apply(editor)
      return
    }
    askSubPageName()
  }

  /**
   * Petit champ de saisie a la place du menu (nom de sous-page, adresse
   * d'un lien). C'est un champ de formulaire : Entree valide, Echap annule.
   */
  function askInput(placeholder: string, testid: string, initial: string, at: number, done: (value: string | null) => void): void {
    if (!menu.el || !editor) return
    menu.naming = true
    const box = menu.el
    box.replaceChildren()
    const input = el('input', 'page-menu-input')
    input.dataset.testid = testid
    input.placeholder = placeholder
    input.value = initial
    const finish = (ok: boolean) => {
      if (!menu.naming) return
      closeMenu()
      done(ok ? input.value : null)
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
      e.stopPropagation()
    })
    input.addEventListener('blur', () => finish(false))
    const coords = editor.view.coordsAtPos(at)
    const bodyBox = root!.querySelector<HTMLElement>('.page-body')!.getBoundingClientRect()
    box.style.left = `${Math.max(0, coords.left - bodyBox.left)}px`
    box.style.top = `${coords.bottom - bodyBox.top + 4}px`
    box.append(input)
    box.hidden = false
    input.focus()
  }

  function askSubPageName(): void {
    if (!editor) return
    const insertAt = editor.state.selection.from
    askInput('Nom de la sous-page', 'page-subpage-name', '', insertAt, (name) => {
      if (!editor) return
      if (!name?.trim()) { editor.commands.focus(); return }
      void createSubPage(name).then((target) => {
        if (!target || !editor || editor.isDestroyed) return
        editor.chain().focus(insertAt).insertContent({ type: 'pageLink', attrs: { target } }).run()
      }).catch((err) => {
        console.error('[plugin-page] sous-page', err)
        setStatus('La sous-page n\'a pas pu être créée.', 'error')
      })
    })
  }

  /** Ctrl+K : poser, changer ou retirer (adresse vide) un lien. */
  function promptLink(): void {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    const current = String(editor.getAttributes('link').href ?? '')
    askInput('Adresse du lien', 'page-link-input', current, from, (href) => {
      if (!editor || href === null) { editor?.commands.focus(); return }
      const url = href.trim()
      const chain = editor.chain().focus().setTextSelection({ from, to })
      if (!url) { chain.extendMarkRange('link').unsetLink().run(); return }
      if (empty && !current) {
        chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }).run()
      } else {
        chain.extendMarkRange('link').setLink({ href: url }).run()
      }
    })
  }

  /** Ce que les commandes page:* pilotent dans cette vue. */
  const controller: PageController = {
    menuOpen: () => menu.open && !menu.naming,
    menuMove(step) {
      const n = menu.items.length
      if (n) menu.index = (menu.index + (step === 1 ? 1 : n - 1)) % n
      renderMenu()
    },
    menuChoose() {
      const item = menu.items[menu.index]
      if (item) choose(item)
      else closeMenu()
    },
    menuClose() {
      menu.dismissedAt = menu.from
      closeMenu()
    },
    promptLink,
  }

  // ── Poignee de deplacement des blocs ─────────────────────────────────

  let handle: HTMLElement | null = null
  let handleBlock: { pos: number; dom: HTMLElement } | null = null

  function topLevelBlockAt(target: EventTarget | null): { pos: number; dom: HTMLElement } | null {
    if (!editor || !(target instanceof Node)) return null
    const pmRoot = editor.view.dom
    let node: Node | null = target
    while (node && node.parentNode !== pmRoot) node = node.parentNode
    if (!(node instanceof HTMLElement)) return null
    const index = Array.prototype.indexOf.call(pmRoot.children, node)
    if (index < 0 || index >= editor.state.doc.childCount) return null
    let pos = 0
    for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize
    return { pos, dom: node }
  }

  function placeHandle(block: { pos: number; dom: HTMLElement } | null): void {
    if (!handle || !root) return
    handleBlock = block
    if (!block || !editor?.isEditable) { handle.hidden = true; return }
    const body = root.querySelector<HTMLElement>('.page-body')!.getBoundingClientRect()
    const rect = block.dom.getBoundingClientRect()
    handle.style.top = `${rect.top - body.top}px`
    handle.hidden = false
  }

  function selectHandleBlock(): boolean {
    if (!editor || !handleBlock) return false
    const { pos } = handleBlock
    if (pos >= editor.state.doc.content.size) return false
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)))
    return true
  }

  // ── Montage ──────────────────────────────────────────────────────────

  async function connectStorage(): Promise<void> {
    if (ctx.tree) {
      treeMirror = new TreeMirror(fragment, ctx.tree)
      treeMirror.attach()
      return
    }
    if (!vault) {
      forcedReadOnly = true
      applyEditable()
      setStatus('Page en lecture seule : aucun stockage disponible.')
      return
    }
    const mirror = new VaultMirror(fragment, vault, path, {
      onSaved: raw => ctx.onContentStabilized?.(raw),
      onError: err => {
        console.error('[plugin-page] enregistrement', err)
        setStatus('Enregistrement impossible.', 'error')
      },
    })
    vaultMirror = mirror
    try {
      await mirror.load()
      // Vue fermee pendant la lecture : on n'ecoute plus rien.
      if (destroyed) await mirror.destroy()
    } catch (err) {
      vaultMirror = null
      if (destroyed) return
      forcedReadOnly = true
      applyEditable()
      const why = err instanceof PageFileError ? err.message : 'Lecture impossible.'
      setStatus(`${why} La page reste en lecture seule et n'est pas modifiée.`, 'error')
      if (!(err instanceof PageFileError)) console.error('[plugin-page] lecture', err)
    }
  }

  return {
    mount(container: HTMLElement) {
      root = el('div', 'savoire-page')
      root.dataset.testid = 'page-view'
      const style = el('style')
      style.textContent = PAGE_CSS
      const header = el('div', 'page-header')
      const title = el('h1', 'page-title', fileName)
      title.dataset.testid = 'page-title'
      header.append(title)
      status = el('div', 'page-status')
      status.hidden = true
      const body = el('div', 'page-body')
      const editorEl = el('div', 'page-editor')
      handle = el('div', 'page-handle', '⋮⋮')
      handle.dataset.testid = 'page-drag-handle'
      handle.title = 'Glisser pour déplacer · cliquer pour sélectionner'
      handle.draggable = true
      handle.hidden = true
      menu.el = el('div', 'page-menu')
      menu.el.dataset.testid = 'page-slash-menu'
      menu.el.hidden = true
      body.append(editorEl, handle, menu.el)
      root.append(style, header, status, body)
      container.replaceChildren(root)

      editor = new Editor({
        element: editorEl,
        editable: !readOnly,
        extensions: pageExtensions({ pageLink: PageLinkCard, extra: [privateYSync(fragment)] }),
        ...PAGE_EDITOR_OPTIONS,
        editorProps: {
          attributes: { class: 'page-prosemirror', 'data-testid': 'page-editor' },
          // Toutes les touches passent par le moteur de raccourcis ; ce qu'il
          // ne prend pas reste de la frappe ordinaire, pour Tiptap.
          handleKeyDown: (_view, event) => deps.hotkeys?.handleKeyEvent(event, { editorView: null }) ?? false,
        },
      })
      cleanups.push(trackPageEditor(editor, controller))
      editorsByContainer.set(container, editor)
      cleanups.push(() => editorsByContainer.delete(container))
      editor.on('transaction', () => updateMenu())
      editor.on('blur', () => { if (!menu.naming) closeMenu() })

      editorEl.addEventListener('mousemove', (e) => {
        const block = topLevelBlockAt(e.target)
        if (block) placeHandle(block)
      })
      body.addEventListener('mouseleave', () => placeHandle(null))
      handle.addEventListener('mousedown', () => { selectHandleBlock() })
      handle.addEventListener('dragstart', (e) => {
        if (!editor || !handleBlock || !selectHandleBlock()) { e.preventDefault(); return }
        const slice = editor.state.selection.content()
        // ProseMirror deplace le bloc au depot : c'est son propre glisser-deposer.
        ;(editor.view as unknown as { dragging: unknown }).dragging = { slice, move: true }
        e.dataTransfer?.setData('text/plain', editor.state.doc.nodeAt(handleBlock.pos)?.textContent ?? '')
        e.dataTransfer?.setDragImage(handleBlock.dom, 0, 0)
      })

      applyEditable()
      void connectStorage()
    },

    setReadOnly(next: boolean) {
      readOnly = next
      applyEditable()
      if (!editor?.isEditable) closeMenu()
    },

    destroy() {
      destroyed = true
      for (const c of cleanups.splice(0)) c()
      treeMirror?.detach()
      treeMirror = null
      void vaultMirror?.destroy()
      vaultMirror = null
      editor?.destroy()
      editor = null
      ydoc.destroy()
      root?.remove()
      root = null
    },
  }
}

