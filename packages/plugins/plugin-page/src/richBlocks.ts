// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Blocs de page en plus du kit de base, ceux qu'une page Notion contient
// souvent (ADR-035) :
//
//   callout   encadre : une icone (emoji), une couleur, des blocs ;
//   toggle    bloc repliable : un titre (toggleTitle), puis des blocs ;
//             `heading` 1 a 3 : un titre repliable (0 : texte simple) ;
//   image     une image : `src` est le chemin d'une piece jointe du vault
//             (« Projet/photo.png ») ou une adresse https ; `alt` sa legende ;
//   table     tableau simple : lignes (tableRow) de cases (tableCell, des
//             paragraphes) ; une case `header` est un en-tete.
//
// Aucun acces au DOM ici (voir schema.ts) : les vues interactives (repli,
// image du vault) sont dans view.ts. Ouvert ou replie, un bloc repliable
// l'est pour la personne seulement : rien n'est ecrit dans la page.
import { Node, mergeAttributes } from '@tiptap/core'

/** Couleurs d'un encadre : celles de Notion, ramenees a sept. */
export const CALLOUT_COLORS = ['default', 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const
export type CalloutColor = typeof CALLOUT_COLORS[number]

export function calloutColorOf(v: unknown): CalloutColor {
  return typeof v === 'string' && (CALLOUT_COLORS as readonly string[]).includes(v) ? v as CalloutColor : 'default'
}

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  draggable: true,

  addAttributes() {
    return {
      icon: {
        default: '💡',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-icon') ?? '💡',
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-icon': String(attrs.icon ?? '') }),
      },
      color: {
        default: 'default',
        parseHTML: (el: HTMLElement) => calloutColorOf(el.getAttribute('data-color')),
        renderHTML: (attrs: Record<string, unknown>) => ({ 'data-color': calloutColorOf(attrs.color) }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]', contentElement: '.page-callout-body' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'page-callout' }),
      ['span', { class: 'page-callout-icon', contenteditable: 'false' }, String(node.attrs.icon || '💡')],
      ['div', { class: 'page-callout-body' }, 0]]
  },
})

export const ToggleTitle = Node.create({
  name: 'toggleTitle',
  content: 'inline*',
  defining: true,

  parseHTML() {
    return [{ tag: 'div[data-toggle-title]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toggle-title': '', class: 'page-toggle-title' }), 0]
  },
})

export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'toggleTitle block*',
  defining: true,
  draggable: true,

  addAttributes() {
    return {
      heading: {
        default: 0,
        parseHTML: (el: HTMLElement) => Number(el.getAttribute('data-heading') ?? 0) || 0,
        renderHTML: (attrs: Record<string, unknown>) => (Number(attrs.heading) ? { 'data-heading': String(attrs.heading) } : {}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-toggle]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-toggle': '', class: 'page-toggle' }), 0]
  },
})

export const PageImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: '', parseHTML: (el: HTMLElement) => el.getAttribute('data-src') ?? el.getAttribute('src') ?? '' },
      alt: { default: '', parseHTML: (el: HTMLElement) => el.getAttribute('alt') ?? '' },
    }
  },

  parseHTML() {
    return [{ tag: 'figure[data-image]' }, { tag: 'img[src]' }]
  },

  renderHTML({ node }) {
    // Le chemin d'une piece jointe n'est pas une adresse : la vue le resout.
    const src = String(node.attrs.src ?? '')
    const alt = String(node.attrs.alt ?? '')
    return ['figure', { 'data-image': '', 'data-src': src, class: 'page-image' },
      ['img', { alt, ...( /^https:\/\//i.test(src) ? { src } : {}) }],
      ...(alt ? [['figcaption', {}, alt] as const] : [])]
  },
})

export const PageTableCell = Node.create({
  name: 'tableCell',
  content: 'paragraph+',
  isolating: true,

  addAttributes() {
    return {
      header: {
        default: false,
        parseHTML: (el: HTMLElement) => el.tagName === 'TH',
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'td' }, { tag: 'th' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [node.attrs.header ? 'th' : 'td', HTMLAttributes, 0]
  },
})

export const PageTableRow = Node.create({
  name: 'tableRow',
  content: 'tableCell+',

  parseHTML() {
    return [{ tag: 'tr' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['tr', HTMLAttributes, 0]
  },
})

export const PageTable = Node.create({
  name: 'table',
  group: 'block',
  content: 'tableRow+',
  isolating: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'table' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', { class: 'page-table-wrap' }, ['table', mergeAttributes(HTMLAttributes, { class: 'page-table' }), ['tbody', 0]]]
  },
})

/** Les blocs riches, dans l'ordre ou le schema les declare. */
export function richBlockExtensions() {
  return [Callout, ToggleTitle, Toggle, PageImage, PageTableCell, PageTableRow, PageTable]
}

// ── Contenus a inserer (menu « / ») ──────────────────────────────────────

const paragraph = (text = '') => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' })

export function calloutContent(): Record<string, unknown> {
  return { type: 'callout', attrs: { icon: '💡', color: 'default' }, content: [paragraph()] }
}

export function toggleContent(): Record<string, unknown> {
  return { type: 'toggle', content: [{ type: 'toggleTitle' }, paragraph()] }
}

export function tableContent(rows = 3, cols = 3): Record<string, unknown> {
  const row = (header: boolean) => ({
    type: 'tableRow',
    content: Array.from({ length: cols }, () => ({ type: 'tableCell', attrs: { header }, content: [paragraph()] })),
  })
  return { type: 'table', content: Array.from({ length: rows }, (_, i) => row(i === 0)) }
}
