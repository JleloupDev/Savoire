// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-outline — « Plans » : des listes imbriquees a la Workflowy, dans des
// fichiers .outline.
//
// Comportements inspires d'obsidian-outliner, de Viacheslav Slinko, MIT
// (https://github.com/vslinko/obsidian-outliner). Le code est ecrit pour
// Savoire : seuls les comportements sont repris, pas le code.
//
// Le fichier reste une liste Markdown ordinaire (« - element », deux espaces
// par niveau), lisible dans n'importe quel editeur. Le pliage et le zoom ne
// sont que des etats de la vue : rien de tout ca n'est ecrit dans le fichier.
//
// Edition a plusieurs : le texte du document est un CRDT (ctx.text). Sans
// lui (pas de session de vault), la vue est en lecture seule : un type 'crdt'
// n'a pas de verrou, et ecrire des instantanes sans verrou ferait perdre en
// silence le travail d'un autre membre.
import type {
  FileContext,
  FileView,
  Hotkey,
  PluginAPI,
  PluginCommand,
  VaultPlugin,
} from '@savoire/plugin-api'
import { OutlineEditor, focusedOutline, outlineActions, type OutlineActionName } from './view'

export { OutlineEditor, focusedOutline, outlineActions } from './view'
export type { OutlineAction, OutlineActionName, OutlineEditorOptions } from './view'
export * from './outline'
export { changesToDelta, deltaToChanges, sharedTextBinding } from './binding'

const STABILIZE_MS = 1000

const hk = (key: string, ...modifiers: Hotkey['modifiers']): Hotkey => ({ modifiers, key })

/**
 * Toutes les actions du plan sont des commandes du moteur de raccourcis :
 * la vue ne gere aucune touche elle-meme, et chaque touche se change dans
 * Parametres > Raccourcis.
 *
 * Raccourcis par defaut proches d'obsidian-outliner et de Workflowy. Le
 * deplacement repond aussi a Alt+Haut/Bas, la touche qui deplace une ligne
 * dans Plume : dans un plan, c'est l'element avec ses enfants (pas de
 * conflit : les commandes de Plume ne s'appliquent que dans Plume).
 */
const COMMANDS: Array<{ id: string; label: string; action: OutlineActionName; hotkeys?: Hotkey[] }> = [
  { id: 'outline:new-item', label: 'Plan : nouvel élément', action: 'enter', hotkeys: [hk('Enter')] },
  { id: 'outline:delete-empty-item', label: 'Plan : effacer au début de l\'élément (le joindre au précédent)',
    action: 'backspace', hotkeys: [hk('Backspace')] },
  { id: 'outline:indent', label: 'Plan : indenter l\'élément', action: 'indent', hotkeys: [hk('Tab')] },
  { id: 'outline:dedent', label: 'Plan : désindenter l\'élément', action: 'dedent', hotkeys: [hk('Tab', 'Shift')] },
  { id: 'outline:add-note', label: 'Plan : ajouter une note à l\'élément', action: 'addNote',
    hotkeys: [hk('Enter', 'Shift')] },
  { id: 'outline:move-item-up', label: 'Plan : monter l\'élément', action: 'moveUp',
    hotkeys: [hk('ArrowUp', 'Alt'), hk('ArrowUp', 'Mod', 'Shift')] },
  { id: 'outline:move-item-down', label: 'Plan : descendre l\'élément', action: 'moveDown',
    hotkeys: [hk('ArrowDown', 'Alt'), hk('ArrowDown', 'Mod', 'Shift')] },
  { id: 'outline:fold', label: 'Plan : plier', action: 'fold', hotkeys: [hk('ArrowUp', 'Mod')] },
  { id: 'outline:unfold', label: 'Plan : déplier', action: 'unfold', hotkeys: [hk('ArrowDown', 'Mod')] },
  { id: 'outline:toggle-fold', label: 'Plan : plier / déplier', action: 'toggleFold' },
  { id: 'outline:zoom-in', label: 'Plan : entrer dans l\'élément', action: 'zoomIn',
    hotkeys: [hk('.', 'Mod'), hk('ArrowRight', 'Alt')] },
  { id: 'outline:zoom-out', label: 'Plan : remonter d\'un niveau', action: 'zoomOut',
    hotkeys: [hk('Escape'), hk('.', 'Mod', 'Shift'), hk('ArrowLeft', 'Alt')] },
  { id: 'outline:select-item', label: 'Plan : sélectionner l\'élément, puis tout', action: 'selectItem',
    hotkeys: [hk('a', 'Mod')] },
]

/**
 * Commandes du moteur de raccourcis. Disponibles seulement quand un plan a
 * le focus ET que l'action s'applique (Retour arriere : au debut d'un
 * element...) ; sinon la touche suit son cours normal.
 */
export function outlineCommands(): PluginCommand[] {
  return COMMANDS.map(c => ({
    id: c.id,
    label: c.label,
    hotkeys: c.hotkeys,
    isAvailable: () => {
      const ed = focusedOutline()
      return !!ed && outlineActions[c.action].available(ed.view)
    },
    run: () => {
      const ed = focusedOutline()
      if (ed) outlineActions[c.action].run(ed.view)
    },
  }))
}

async function readContent(path: string, ctx: FileContext): Promise<string> {
  const vault = ctx.vault
  if (!vault) return ''
  const id = vault.resolveDocumentId(path)
  return id ? vault.read(id) : vault.readDocumentByPath(path)
}

function createOutlineView(path: string, ctx: FileContext, api: PluginAPI | null): FileView {
  let editor: OutlineEditor | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let destroyed = false

  return {
    mount(container: HTMLElement) {
      container.replaceChildren()
      editor = new OutlineEditor({
        parent: container,
        text: ctx.text,
        readOnly: ctx.readOnly,
        title: path.split('/').pop()?.replace(/\.outline$/, ''),
        // Toutes les touches passent par le moteur de raccourcis. Pas de vue
        // d'editeur dans le contexte : les commandes de Plume ne s'y
        // appliquent pas ; celles du plan visent le plan qui a le focus.
        onKeyDown: event => !event.isComposing && (api?.hotkeys?.handleKeyEvent(event, { editorView: null }) ?? false),
        onChange: doc => {
          if (!ctx.onContentStabilized) return
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => ctx.onContentStabilized?.(doc), STABILIZE_MS)
        },
      })
      if (!ctx.text) {
        // Pas de texte partage : on affiche le fichier, sans l'editer.
        const note = document.createElement('div')
        note.dataset.testid = 'outline-readonly-note'
        note.textContent = 'Lecture seule : ce plan n\'est pas relié à la synchronisation du vault.'
        note.style.cssText = 'padding:6px 16px;font:12px var(--font-ui,sans-serif);color:var(--text-muted,#64748b);border-bottom:1px solid var(--border,#e2e8f0)'
        editor.dom.prepend(note)
        readContent(path, ctx)
          .then(doc => { if (!destroyed) editor?.setContent(doc) })
          .catch(err => console.error('[plugin-outline] lecture impossible', path, err))
      }
    },

    setReadOnly(readOnly: boolean) {
      editor?.setReadOnly(readOnly)
    },

    destroy() {
      destroyed = true
      if (timer) clearTimeout(timer)
      editor?.destroy()
      editor = null
    },
  }
}

let pluginAPI: PluginAPI | null = null

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-outline',
    name: 'Plans',
    version: '0.0.1',
    description: 'Des plans à la Workflowy : listes imbriquées, pliage, zoom (fichiers .outline)',
    scope: 'vault',
    permissions: ['ui:editor'],
  },

  async onload(api: PluginAPI) {
    pluginAPI = api
    api.files.register({
      extension: 'outline',
      label: 'Plan',
      icon: '☰',
      // Le texte est un CRDT : edition simultanee, sans verrou.
      collaborationMode: 'crdt',
      creatable: true,
      create: async () => '- ',
      open: (path: string, ctx: FileContext) => createOutlineView(path, ctx, pluginAPI),
    })
    // Apres le type de fichier : un hote minimal (le test du catalogue du
    // store) peut ne fournir que `files`.
    for (const cmd of outlineCommands()) api.commands?.register(cmd)
  },

  async onunload() {
    for (const c of COMMANDS) pluginAPI?.commands?.unregister(c.id)
    pluginAPI?.files.unregister('outline')
    pluginAPI = null
  },
}

export default plugin
