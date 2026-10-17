// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-page : la vue Tiptap montee, reliee a l'arbre partage.
import { describe, expect, it, vi } from 'vitest'
import { CommandRegistryImpl, HotkeyManager, InMemorySharedTree } from '@savoire/plugin-runtime'
import type { FileContext, PluginCommand, TreeChangeInfo, VaultAPI } from '@savoire/plugin-api'
import plugin, { createPageView, focusedPageEditor, pageCommands, pageEditorOf, runPageCommand } from '@savoire/plugin-page'
import { pmToInit, stringifyPageFile } from '@savoire/plugin-page/adapter'

function mount(ctx: Partial<FileContext>, deps = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const view = createPageView('Projet.page', { vaultId: 'v', path: 'Projet.page', ...ctx } as FileContext, deps)
  view.mount(container)
  const editor = pageEditorOf(container)!
  return { container, view, editor }
}

const flush = () => new Promise(r => setTimeout(r, 0))
/** Tiptap donne le focus a l'image suivante : on attend un peu. */
const settle = () => new Promise(r => setTimeout(r, 40))

const DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Bonjour' }] },
  ],
}

describe('plugin-page — vue', () => {
  it('affiche le nom du fichier en titre et le contenu de l\'arbre', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const { container, editor, view } = mount({ tree })
    await flush()
    expect(container.querySelector('[data-testid="page-title"]')?.textContent).toBe('Projet')
    expect(editor.getText()).toBe('Bonjour')
    view.destroy()
  })

  it('n\'ecrit rien dans l\'arbre a l\'ouverture', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const writes: TreeChangeInfo[] = []
    tree.onChange((_c, info) => writes.push(info))
    const { view } = mount({ tree })
    await flush()
    view.destroy()
    expect(writes).toEqual([])
  })

  it('deux vues reliees convergent, et le contenu initial arrive apres l\'ouverture', async () => {
    const ta = new InMemorySharedTree()
    const tb = new InMemorySharedTree()
    InMemorySharedTree.link(ta, tb)
    const a = mount({ tree: ta })
    const b = mount({ tree: tb })
    await flush()

    a.editor.commands.setContent(DOC)
    await flush()
    expect(b.editor.getText()).toBe('Bonjour')

    b.editor.chain().setTextSelection(8).insertContent(' tout le monde').run()
    a.editor.chain().setTextSelection(1).toggleHeading({ level: 1 }).run()
    a.editor.chain().setTextSelection({ from: 1, to: 8 }).toggleBold().run()
    await flush()

    expect(a.editor.getJSON()).toEqual(b.editor.getJSON())
    expect(b.editor.getJSON().content?.[0]).toMatchObject({
      type: 'heading',
      content: [{ type: 'text', text: 'Bonjour', marks: [{ type: 'bold' }] }, { type: 'text', text: ' tout le monde' }],
    })
    a.view.destroy()
    b.view.destroy()
  })

  it('respecte la lecture seule, et en sort sans remontage', async () => {
    const tree = new InMemorySharedTree()
    const { editor, view, container } = mount({ tree, readOnly: true })
    expect(editor.isEditable).toBe(false)
    expect(container.querySelector('.savoire-page')?.classList.contains('is-readonly')).toBe(true)
    view.setReadOnly?.(false)
    expect(pageEditorOf(container)).toBe(editor)
    expect(editor.isEditable).toBe(true)
    view.destroy()
  })

  it('mode local : lit le fichier via le vault sans le reecrire', async () => {
    const write = vi.fn(async () => {})
    const vault = {
      readDocumentByPath: async () => stringifyPageFile(DOC),
      resolveDocumentId: (p: string) => p,
      write,
    } as unknown as VaultAPI
    const { editor, view } = mount({ vault })
    await flush()
    expect(editor.getText()).toBe('Bonjour')
    view.destroy()
    await flush()
    expect(write).not.toHaveBeenCalled()
  })

  it('le bloc sous-page est une carte qui ouvre la page', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit({ type: 'doc', content: [{ type: 'pageLink', attrs: { target: 'Projet/Notes' } }] }))
    const openFile = vi.fn(async () => {})
    const vault = { resolveDocumentId: (p: string) => (p === 'Projet/Notes.page' ? 'id' : undefined) } as unknown as VaultAPI
    const { container, view } = mount({ tree }, { workspace: { openFile }, vault })
    await flush()
    const card = container.querySelector<HTMLElement>('[data-testid="page-link-card"]')!
    expect(card.textContent).toContain('Notes')
    card.click()
    expect(openFile).toHaveBeenCalledWith('Projet/Notes.page')
    view.destroy()
  })

  it('laisse Ctrl+B au moteur de raccourcis : Tiptap ne le prend pas', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const { editor, view } = mount({ tree })
    await flush()
    editor.commands.setTextSelection({ from: 1, to: 8 })
    const ev = new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(ev)
    expect(ev.defaultPrevented).toBe(false)
    expect(editor.isActive('bold')).toBe(false)
    // Temoin : les touches de structure restent a Tiptap (Entree coupe le bloc).
    editor.commands.setTextSelection(8)
    const enter = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })
    editor.view.dom.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(true)
    expect(editor.state.doc.childCount).toBe(2)
    editor.commands.setTextSelection({ from: 1, to: 8 })
    // La commande, elle, met bien en gras.
    editor.commands.toggleBold()
    expect(editor.isActive('bold')).toBe(true)
    view.destroy()
  })

  describe('touches : tout passe par le moteur de raccourcis', () => {
    function withEngine() {
      const registry = new CommandRegistryImpl()
      for (const c of pageCommands()) registry.register(c)
      const hotkeys = new HotkeyManager(registry, 'other')
      const tree = new InMemorySharedTree()
      tree.root.set('doc', pmToInit(DOC))
      const m = mount({ tree }, { hotkeys })
      return { ...m, hotkeys }
    }
    const key = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
      const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(ev)
      return ev
    }

    it('Ctrl+B met en gras via page:toggle-bold', async () => {
      const { editor, view } = withEngine()
      await flush()
      editor.chain().focus().setTextSelection({ from: 1, to: 8 }).run()
      await settle()
      expect(focusedPageEditor()).toBe(editor)
      const ev = key(editor.view.dom, 'b', { code: 'KeyB', ctrlKey: true })
      expect(ev.defaultPrevented).toBe(true)
      expect(editor.isActive('bold')).toBe(true)
      view.destroy()
    })

    it('une touche rebindee dans les parametres remplace la touche par defaut', async () => {
      const { editor, view, hotkeys } = withEngine()
      await flush()
      hotkeys.setCustom('page:toggle-bold', [{ modifiers: ['Mod'], key: 'g' }])
      editor.chain().focus().setTextSelection({ from: 1, to: 8 }).run()
      await settle()
      key(editor.view.dom, 'b', { code: 'KeyB', ctrlKey: true })
      expect(editor.isActive('bold')).toBe(false)
      key(editor.view.dom, 'g', { code: 'KeyG', ctrlKey: true })
      expect(editor.isActive('bold')).toBe(true)
      view.destroy()
    })

    it('Entree et Tab dans une liste, Ctrl+Entree coche la case, Ctrl+Z annule', async () => {
      const { editor, view } = withEngine()
      await flush()
      editor.chain().focus().setTextSelection(8).toggleTaskList().run()
      await settle()
      key(editor.view.dom, 'Enter', { code: 'Enter' })
      editor.commands.insertContent('deux')
      key(editor.view.dom, 'Tab', { code: 'Tab' })
      const list = editor.getJSON().content![0] as { type?: string; content?: Array<{ content?: Array<{ type?: string }> }> }
      expect(list.type).toBe('taskList')
      expect(list.content).toHaveLength(1)
      expect(list.content![0].content![1].type).toBe('taskList')
      key(editor.view.dom, 'Enter', { code: 'Enter', ctrlKey: true })
      expect((editor.getJSON() as any).content[0].content[0].content[1].content[0].attrs?.checked).toBe(true)
      key(editor.view.dom, 'Tab', { code: 'Tab', shiftKey: true })
      expect(editor.getJSON().content![0].content).toHaveLength(2)
      key(editor.view.dom, 'z', { code: 'KeyZ', ctrlKey: true })
      expect(editor.getJSON().content![0].content).toHaveLength(1)
      // Entree sur un element vide en haut de liste : on sort de la liste.
      editor.commands.setTextSelection(editor.state.doc.content.size - 3)
      key(editor.view.dom, 'Enter', { code: 'Enter' })
      key(editor.view.dom, 'Tab', { code: 'Tab', shiftKey: true })
      key(editor.view.dom, 'Enter', { code: 'Enter' })
      expect(editor.getJSON().content!.at(-1)?.type).toBe('paragraph')
      view.destroy()
    })

    it('le menu / se pilote au clavier et insere le bloc choisi', async () => {
      const { editor, view, container } = withEngine()
      await flush()
      editor.chain().focus().setTextSelection(8).splitBlock().insertContent('/tit').run()
      await settle()
      const menu = container.querySelector<HTMLElement>('[data-testid="page-slash-menu"]')!
      expect(menu.hidden).toBe(false)
      expect(Array.from(menu.querySelectorAll('.page-menu-item')).map(e => e.textContent)).toEqual(['H1Titre 1', 'H2Titre 2', 'H3Titre 3'])
      key(editor.view.dom, 'ArrowDown', { code: 'ArrowDown' })
      key(editor.view.dom, 'Enter', { code: 'Enter' })
      expect(menu.hidden).toBe(true)
      expect(editor.getJSON().content![1]).toEqual({ type: 'heading', attrs: { level: 2 } })
      view.destroy()
    })
  })

  it('enregistre le type .page et les commandes page: du moteur de raccourcis', async () => {
    const registered: { files: unknown[]; commands: PluginCommand[] } = { files: [], commands: [] }
    const api = {
      files: { register: (s: unknown) => registered.files.push(s) },
      commands: { register: (c: PluginCommand) => registered.commands.push(c), unregister: vi.fn() },
      workspace: {},
      vault: {},
    }
    await plugin.onload(api as never)
    const spec = registered.files[0] as { extension: string; collaborationMode: string; creatable: boolean; create(): Promise<string> }
    expect(spec).toMatchObject({ extension: 'page', label: 'Page', collaborationMode: 'crdt', creatable: true })
    expect(await spec.create()).toBe('')
    const bold = registered.commands.find(c => c.id === 'page:toggle-bold')!
    expect(bold.hotkeys).toEqual([{ modifiers: ['Mod'], key: 'b' }])
    // Pas de page avec le focus : la touche suit son cours.
    expect(bold.isAvailable?.({ editorView: null })).toBe(false)
    expect(focusedPageEditor()).toBeNull()
    await plugin.onunload()
    expect(api.commands.unregister).toHaveBeenCalledWith('page:toggle-bold')
  })
})

describe('plugin-page — surlignage et barre d\'edition', () => {
  function withEngine(ctx: Partial<FileContext> = {}) {
    const registry = new CommandRegistryImpl()
    for (const c of pageCommands()) registry.register(c)
    const hotkeys = new HotkeyManager(registry, 'other')
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit(DOC))
    const m = mount({ tree, ...ctx }, { hotkeys })
    return { ...m, hotkeys, tree }
  }
  const key = (target: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(ev)
    return ev
  }
  const down = (el: Element) => {
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })
    el.dispatchEvent(ev)
    return ev
  }
  const marksOf = (editor: ReturnType<typeof mount>['editor']) =>
    (editor.getJSON().content![0].content ?? []).map(t => ({ text: (t as { text?: string }).text, marks: t.marks }))

  it('la marque s\'affiche en <mark>, avec la classe de sa couleur', async () => {
    const tree = new InMemorySharedTree()
    tree.root.set('doc', pmToInit({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'a', marks: [{ type: 'highlight' }] },
      { type: 'text', text: 'b', marks: [{ type: 'highlight', attrs: { color: 'green' } }] },
    ] }] }))
    const { container, view } = mount({ tree })
    await flush()
    const marks = Array.from(container.querySelectorAll('mark'))
    expect(marks.map(m => m.className)).toEqual(['page-hl', 'page-hl page-hl-green'])
    expect(marks[1].getAttribute('data-color')).toBe('green')
    view.destroy()
  })

  it('Ctrl+Maj+H surligne via page:toggle-highlight, et le retire au second appui', async () => {
    const { editor, view } = withEngine()
    await flush()
    editor.chain().focus().setTextSelection({ from: 1, to: 8 }).run()
    await settle()
    const ev = key(editor.view.dom, 'H', { code: 'KeyH', ctrlKey: true, shiftKey: true })
    expect(ev.defaultPrevented).toBe(true)
    expect(marksOf(editor)).toEqual([{ text: 'Bonjour', marks: [{ type: 'highlight', attrs: { color: null } }] }])
    key(editor.view.dom, 'H', { code: 'KeyH', ctrlKey: true, shiftKey: true })
    expect(editor.isActive('highlight')).toBe(false)
    view.destroy()
  })

  it('une commande par couleur, sans touche par defaut ; une autre couleur remplace la premiere', async () => {
    const cmds = pageCommands()
    const colors = cmds.filter(c => /^page:highlight-/.test(c.id))
    expect(colors.map(c => c.id)).toEqual(['red', 'orange', 'yellow', 'green', 'blue', 'purple'].map(c => `page:highlight-${c}`))
    expect(colors.every(c => !c.hotkeys?.length)).toBe(true)
    expect(cmds.find(c => c.id === 'page:toggle-highlight')!.hotkeys).toEqual([{ modifiers: ['Mod', 'Shift'], key: 'h' }])

    const { editor, view } = withEngine()
    await flush()
    editor.chain().focus().setTextSelection({ from: 1, to: 8 }).run()
    await settle()
    expect(runPageCommand(editor, 'page:highlight-red')).toBe(true)
    expect(editor.isActive('highlight', { color: 'red' })).toBe(true)
    runPageCommand(editor, 'page:highlight-blue')
    expect(marksOf(editor)).toEqual([{ text: 'Bonjour', marks: [{ type: 'highlight', attrs: { color: 'blue' } }] }])
    runPageCommand(editor, 'page:remove-highlight')
    expect(editor.isActive('highlight')).toBe(false)
    view.destroy()
  })

  it('deux vues reliees : la couleur passe par l\'arbre partage', async () => {
    const ta = new InMemorySharedTree()
    const tb = new InMemorySharedTree()
    InMemorySharedTree.link(ta, tb)
    ta.root.set('doc', pmToInit(DOC))
    const a = mount({ tree: ta })
    const b = mount({ tree: tb })
    await flush()
    a.editor.chain().setTextSelection({ from: 1, to: 4 }).setMark('highlight', { color: 'purple' }).run()
    a.editor.chain().setTextSelection({ from: 4, to: 8 }).setMark('highlight').run()
    await flush()
    expect(marksOf(b.editor)).toEqual([
      { text: 'Bon', marks: [{ type: 'highlight', attrs: { color: 'purple' } }] },
      { text: 'jour', marks: [{ type: 'highlight', attrs: { color: null } }] },
    ])
    a.view.destroy()
    b.view.destroy()
  })

  it('la barre apparait sur une selection, disparait sans selection', async () => {
    const { editor, view, container } = withEngine()
    await flush()
    const bar = container.querySelector<HTMLElement>('[data-testid="page-toolbar"]')!
    expect(bar.hidden).toBe(true)
    editor.chain().focus().setTextSelection({ from: 1, to: 8 }).run()
    await settle()
    expect(bar.hidden).toBe(false)
    editor.commands.setTextSelection(3)
    expect(bar.hidden).toBe(true)
    editor.commands.setTextSelection({ from: 1, to: 4 })
    expect(bar.hidden).toBe(false)
    editor.commands.blur()
    await settle()
    expect(bar.hidden).toBe(true)
    view.destroy()
  })

  it('un bouton lance la meme commande que la touche, sans voler le focus', async () => {
    const { editor, view, container, hotkeys } = withEngine()
    await flush()
    editor.chain().focus().setTextSelection({ from: 1, to: 8 }).run()
    await settle()
    const bar = container.querySelector<HTMLElement>('[data-testid="page-toolbar"]')!
    const bold = bar.querySelector<HTMLElement>('[data-command-id="page:toggle-bold"]')!
    expect(bold.title).toBe('Gras (Ctrl+B)')
    // L'infobulle suit la touche choisie dans les parametres.
    hotkeys.setCustom('page:toggle-bold', [{ modifiers: ['Mod'], key: 'g' }])
    editor.commands.setTextSelection({ from: 1, to: 8 })
    expect(bold.title).toBe('Gras (Ctrl+G)')
    expect(down(bold).defaultPrevented).toBe(true)
    expect(editor.isActive('bold')).toBe(true)
    expect(bold.classList.contains('is-active')).toBe(true)
    expect(editor.isFocused).toBe(true)

    // Surligner : un menu de couleurs, « sans couleur » et « retirer ».
    const hl = bar.querySelector<HTMLElement>('[data-key="highlight"]')!
    const menu = bar.querySelector<HTMLElement>('[data-testid="page-toolbar-menu-highlight"]')!
    expect(menu.hidden).toBe(true)
    down(hl)
    expect(menu.hidden).toBe(false)
    expect(Array.from(menu.querySelectorAll('[data-command-id]')).map(e => e.getAttribute('data-command-id'))).toEqual([
      'page:toggle-highlight', ...['red', 'orange', 'yellow', 'green', 'blue', 'purple'].map(c => `page:highlight-${c}`), 'page:remove-highlight',
    ])
    expect(menu.querySelector<HTMLElement>('[data-command-id="page:toggle-highlight"]')!.title).toBe('Sans couleur (Ctrl+Maj+H)')
    down(menu.querySelector('[data-command-id="page:highlight-orange"]')!)
    expect(editor.isActive('highlight', { color: 'orange' })).toBe(true)
    expect(menu.hidden).toBe(true)
    down(hl)
    down(menu.querySelector('[data-command-id="page:remove-highlight"]')!)
    expect(editor.isActive('highlight')).toBe(false)
    view.destroy()
  })

  it('transforme le bloc depuis la barre', async () => {
    const { editor, view, container } = withEngine()
    await flush()
    editor.chain().focus().setTextSelection({ from: 1, to: 8 }).run()
    await settle()
    const bar = container.querySelector<HTMLElement>('[data-testid="page-toolbar"]')!
    const block = bar.querySelector<HTMLElement>('[data-key="block"]')!
    expect(block.textContent).toBe('Texte ▾')
    down(block)
    down(bar.querySelector('[data-command-id="page:heading-2"]')!)
    expect(editor.getJSON().content![0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    expect(block.textContent).toBe('Titre 2 ▾')
    // Choisir le type deja en place ne l'annule pas.
    down(block)
    down(bar.querySelector('[data-command-id="page:heading-2"]')!)
    expect(editor.getJSON().content![0].type).toBe('heading')
    down(block)
    down(bar.querySelector('[data-command-id="page:toggle-checklist"]')!)
    expect(editor.getJSON().content![0].type).toBe('taskList')
    down(block)
    down(bar.querySelector('[data-command-id="page:set-paragraph"]')!)
    expect(editor.getJSON().content![0].type).toBe('paragraph')
    view.destroy()
  })

  it('pas de barre en lecture seule', async () => {
    const { editor, view, container } = withEngine({ readOnly: true })
    await flush()
    editor.chain().focus().setTextSelection({ from: 1, to: 8 }).run()
    await settle()
    expect(container.querySelector<HTMLElement>('[data-testid="page-toolbar"]')!.hidden).toBe(true)
    view.destroy()
  })
})
