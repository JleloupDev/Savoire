// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Le modele d'une page : les extensions Tiptap qui fixent ses blocs.
//
// Aucun acces au DOM ici : les tests construisent le schema en Node.
//
// Raccourcis : un plugin ne gere jamais ses touches lui-meme. Toute action
// au clavier (gras, titres, listes, annuler, Entree dans une liste, Tab...)
// est une commande `page:*` du moteur de raccourcis de l'application (voir
// commands.ts) : la personne la voit et la change dans Parametres >
// Raccourcis. On retire donc ces touches des extensions Tiptap. Ne restent
// a Tiptap que les touches de frappe ordinaire : Entree et Retour arriere
// hors liste, Suppr, et les comportements de bloc sans modificateur (sortir
// d'un bloc de code, fusionner des elements de liste au Retour arriere).
import { Node, extensions as core, flattenExtensions, mergeAttributes, type AnyExtension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'

/** Une touche avec modificateur (Maj comprise) : c'est une action. */
const MODIFIED_KEY = /(^|-)(Mod|Ctrl|Alt|Meta|Cmd|Shift)-/

/** Touches sans modificateur qui sont des actions de liste (commandes page:*). */
const LIST_ACTION_KEYS = new Set(['Enter', 'Tab'])
const LIST_ITEMS = new Set(['listItem', 'taskItem'])

/** Garde d'une extension les seules touches de frappe ordinaire. */
function withoutActionKeys(ext: AnyExtension): AnyExtension {
  const isItem = LIST_ITEMS.has(ext.name)
  return ext.extend({
    addKeyboardShortcuts() {
      const parent = (this as { parent?: () => Record<string, unknown> }).parent
      const all = parent?.() ?? {}
      return Object.fromEntries(Object.entries(all).filter(([key]) =>
        !MODIFIED_KEY.test(key) && !(isItem && LIST_ACTION_KEYS.has(key)))) as never
    },
  })
}

/**
 * Options de l'editeur qui vont avec pageExtensions() : le keymap de base
 * de Tiptap est remplace par une version sans actions (Ctrl+A, Ctrl+Entree...).
 */
export const PAGE_EDITOR_OPTIONS = { enableCoreExtensions: { keymap: false } } as const

/** Nom affiche d'une sous-page : le dernier segment de sa cible. */
export function pageLinkLabel(target: string): string {
  return target.split('/').filter(Boolean).at(-1) ?? target
}

/**
 * Lien vers une sous-page : un bloc carte. `target` est le chemin de la page
 * dans le vault, sans extension (« Projet/Nom »), comme un [[lien wiki]].
 */
export const PageLink = Node.create({
  name: 'pageLink',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      target: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-page-link') ?? '',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-page-link': String(attrs.target ?? '') }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-page-link]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { class: 'page-link-card' }), pageLinkLabel(String(node.attrs.target))]
  },
})

export interface PageExtensionOptions {
  placeholder?: string
  /** Version du bloc sous-page a utiliser (avec sa vue cliquable). */
  pageLink?: AnyExtension
  /** Extensions en plus (synchronisation, vues de noeuds...). */
  extra?: AnyExtension[]
}

/** Toutes les extensions d'une page. */
export function pageExtensions(options: PageExtensionOptions = {}): AnyExtension[] {
  const kit = StarterKit.configure({
    // L'historique est celui du Y.Doc prive (y-prosemirror) : il n'annule
    // que ses propres modifications, jamais celles des autres membres.
    undoRedo: false,
    // Pas de souligne : rien ne l'exprime en Markdown (export d'indexation).
    underline: false,
    // Le noeud final ajoute automatiquement serait une ecriture a
    // l'ouverture, sans geste de la personne : non.
    trailingNode: false,
    link: { openOnClick: false, autolink: true },
  })
  // Les extensions du kit, a plat pour pouvoir retoucher leurs touches. Une
  // extension qui en ajoute d'autres (listItem...) les rajoutera elle-meme :
  // on ne garde pas ses enfants, sinon ils seraient en double.
  const flat = flattenExtensions([kit]).filter(e => e.name !== kit.name)
  const nested = new Set(flat.flatMap(e => flattenExtensions([e]).slice(1).map(x => x.name)))
  const kitParts = flat.filter(e => !nested.has(e.name))
  const all: AnyExtension[] = [
    ...kitParts,
    TaskList,
    TaskItem.configure({ nested: true }),
    options.pageLink ?? PageLink,
    Placeholder.configure({
      placeholder: options.placeholder ?? 'Tapez / pour les commandes',
      showOnlyCurrent: true,
    }),
    core.Keymap,
    ...(options.extra ?? []),
  ]
  return all.map(withoutActionKeys)
}
