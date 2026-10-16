// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Les blocs qu'on insere avec le menu « / ».
import type { Editor } from '@tiptap/core'

export interface BlockItem {
  id: string
  label: string
  icon: string
  /** Mots qui le trouvent aussi dans le filtre. */
  keywords: string[]
  /** Absent pour la sous-page : la vue demande d'abord son nom. */
  apply?: (editor: Editor) => void
}

export const BLOCK_ITEMS: BlockItem[] = [
  { id: 'text', label: 'Texte', icon: '¶', keywords: ['paragraphe', 'text'], apply: e => { e.chain().focus().setParagraph().run() } },
  { id: 'h1', label: 'Titre 1', icon: 'H1', keywords: ['heading', 'titre'], apply: e => { e.chain().focus().setHeading({ level: 1 }).run() } },
  { id: 'h2', label: 'Titre 2', icon: 'H2', keywords: ['heading', 'titre'], apply: e => { e.chain().focus().setHeading({ level: 2 }).run() } },
  { id: 'h3', label: 'Titre 3', icon: 'H3', keywords: ['heading', 'titre'], apply: e => { e.chain().focus().setHeading({ level: 3 }).run() } },
  { id: 'bullet', label: 'Liste à puces', icon: '•', keywords: ['liste', 'bullet', 'puces'], apply: e => { e.chain().focus().toggleBulletList().run() } },
  { id: 'ordered', label: 'Liste numérotée', icon: '1.', keywords: ['liste', 'numero', 'ordered'], apply: e => { e.chain().focus().toggleOrderedList().run() } },
  { id: 'task', label: 'Liste de tâches', icon: '☐', keywords: ['tache', 'todo', 'case', 'checkbox'], apply: e => { e.chain().focus().toggleTaskList().run() } },
  { id: 'quote', label: 'Citation', icon: '❝', keywords: ['quote', 'citation'], apply: e => { e.chain().focus().toggleBlockquote().run() } },
  { id: 'code', label: 'Code', icon: '</>', keywords: ['code', 'bloc'], apply: e => { e.chain().focus().toggleCodeBlock().run() } },
  { id: 'divider', label: 'Séparateur', icon: '—', keywords: ['separateur', 'ligne', 'hr', 'divider'], apply: e => { e.chain().focus().setHorizontalRule().run() } },
  { id: 'subpage', label: 'Sous-page', icon: '📄', keywords: ['page', 'sous-page', 'lien'] },
]

/** Sans accents ni casse, pour le filtre. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/** Blocs qui repondent au texte tape apres « / ». */
export function filterBlocks(query: string, items: readonly BlockItem[] = BLOCK_ITEMS): BlockItem[] {
  const q = fold(query.trim())
  if (!q) return [...items]
  return items.filter(i => [i.label, i.id, ...i.keywords].some(w => fold(w).includes(q)))
}

/**
 * Le menu « / » est-il ouvert ? On regarde le texte du bloc avant le
 * curseur : un « / » en debut de bloc ou apres une espace, suivi d'un mot.
 * Rend la position du « / » dans ce texte et le filtre, ou null.
 */
export function matchSlash(textBefore: string): { offset: number; query: string } | null {
  const m = /(^|\s)\/([^\s/]{0,24})$/.exec(textBefore)
  if (!m) return null
  return { offset: m.index + m[1].length, query: m[2] }
}
