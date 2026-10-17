// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Surlignage des pages : une marque `highlight`, avec ou sans couleur.
//
// Les six couleurs sont celles d'Obsidian, les memes que Plume
// (packages/editor-core/src/PlumeMarkdown.ts). Le plugin ne depend pas de
// l'editeur Markdown : la petite table est recopiee ici, a garder alignee.
//
// Forme dans le contenu : `{ type: 'highlight', attrs: { color } }`, color
// valant null (couleur du theme) ou l'un des six noms. En Markdown (export
// d'indexation) : `==texte==` et `==🔴texte==`, comme Obsidian et Plume.
//
// Aucune touche ici : Ctrl+Maj+H est la commande page:toggle-highlight du
// moteur de raccourcis (commands.ts). Reste la saisie `==texte==`, une regle
// de frappe ordinaire.
import { Mark, markInputRule, markPasteRule, mergeAttributes } from '@tiptap/core'

export type PageColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'

export const PAGE_COLORS: ReadonlyArray<{ color: PageColor; emoji: string; label: string }> = [
  { color: 'red', emoji: '🔴', label: 'Rouge' },
  { color: 'orange', emoji: '🟠', label: 'Orange' },
  { color: 'yellow', emoji: '🟡', label: 'Jaune' },
  { color: 'green', emoji: '🟢', label: 'Vert' },
  { color: 'blue', emoji: '🔵', label: 'Bleu' },
  { color: 'purple', emoji: '🟣', label: 'Violet' },
]

/** Fond de chaque couleur : translucide, lisible en theme clair et sombre. */
export const PAGE_HIGHLIGHT_VALUES: Record<PageColor, string> = {
  red: 'rgba(233, 49, 71, 0.35)',
  orange: 'rgba(236, 117, 0, 0.35)',
  yellow: 'rgba(224, 172, 0, 0.40)',
  green: 'rgba(8, 185, 78, 0.35)',
  blue: 'rgba(8, 109, 221, 0.35)',
  purple: 'rgba(120, 82, 238, 0.35)',
}

const COLOR_NAMES = new Set<string>(PAGE_COLORS.map(c => c.color))

/** Une couleur connue, sinon null (couleur du theme). */
export function pageColorOf(value: unknown): PageColor | null {
  return typeof value === 'string' && COLOR_NAMES.has(value) ? value as PageColor : null
}

/** Emoji d'une couleur, pour le Markdown (`==🔴texte==`). */
export function emojiOfColor(color: PageColor): string {
  return PAGE_COLORS.find(c => c.color === color)!.emoji
}

/** `==texte==` tape ou colle : le texte est surligne (sans couleur). */
const TYPED = /(?:^|\s)(==([^=\s](?:[^=]*[^=\s])?)==)$/
const PASTED = /(?:^|\s)(==([^=\s](?:[^=]*[^=\s])?)==)/g

export const Highlight = Mark.create({
  name: 'highlight',

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el: HTMLElement) => pageColorOf(el.getAttribute('data-color')),
        renderHTML: (attrs: Record<string, unknown>) => {
          const color = pageColorOf(attrs.color)
          return color ? { 'data-color': color, class: `page-hl-${color}` } : {}
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'mark' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes({ class: 'page-hl' }, HTMLAttributes), 0]
  },

  addInputRules() {
    return [markInputRule({ find: TYPED, type: this.type })]
  },

  addPasteRules() {
    return [markPasteRule({ find: PASTED, type: this.type })]
  },
})
