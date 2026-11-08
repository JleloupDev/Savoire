// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Mise en forme a la position du curseur : ce qui allume les boutons de la
// barre (gras, liste...) et donne le style du paragraphe (« Titre 1 »).
// Le debut de la selection fait foi, comme dans un traitement de texte.

import type { EditorState } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { COLOR_EMOJI_SOURCE, colorOfEmoji, type PlumeColor } from './PlumeMarkdown'
import { lineColorOf } from './FormattingService'

export type BlockStyle = 'paragraph' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'blockquote' | 'codeblock'
export type ListStyle = 'ul' | 'ol' | 'tasklist'
export type InlineStyle = 'bold' | 'italic' | 'strike' | 'code' | 'highlight'

export interface FormatState {
  block: BlockStyle
  list: ListStyle | null
  inline: ReadonlySet<InlineStyle>
  /** Couleur du surlignage sous le curseur (null : celle du theme). */
  highlightColor: PlumeColor | null
  /** Couleur du texte de la ligne. */
  textColor: PlumeColor | null
}

type SyntaxNode = ReturnType<ReturnType<typeof syntaxTree>['resolveInner']>

const INLINE_NODES: Record<string, InlineStyle> = {
  StrongEmphasis: 'bold',
  Emphasis: 'italic',
  Strikethrough: 'strike',
  InlineCode: 'code',
}

const HIGHLIGHT_RE = new RegExp(`==(?!=)(${COLOR_EMOJI_SOURCE})?([^\\n]*?[^\\s=]|)==(?!=)`, 'gu')

// Une barre interroge l'etat une fois par bouton : calcule une fois par etat.
const cache = new WeakMap<EditorState, FormatState>()

export function formatStateAt(state: EditorState): FormatState {
  let found = cache.get(state)
  if (!found) { found = compute(state); cache.set(state, found) }
  return found
}

function compute(state: EditorState): FormatState {
  const sel = state.selection.main
  // Curseur colle a la fin d'un mot gras : on regarde a gauche. Selection :
  // on regarde son premier caractere.
  const pos = sel.empty ? sel.head : sel.from
  const side = sel.empty ? -1 : 1
  const inline = new Set<InlineStyle>()
  let block: BlockStyle = 'paragraph'

  const tree = syntaxTree(state)
  for (let n: SyntaxNode | null = tree.resolveInner(pos, side); n; n = n.parent) {
    const style = INLINE_NODES[n.name]
    if (style) inline.add(style)
    if (n.name === 'FencedCode' || n.name === 'CodeBlock') block = 'codeblock'
  }
  // Le curseur colle au marqueur ouvrant (|**gras**) n'est pas dans le gras.
  if (sel.empty) {
    for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
      const style = INLINE_NODES[n.name]
      if (style && n.from === pos) inline.delete(style)
    }
  }

  const line = state.doc.lineAt(pos)
  const text = line.text
  let highlightColor: PlumeColor | null = null
  if (text.includes('==')) {
    const at = pos - line.from
    for (const m of text.matchAll(HIGHLIGHT_RE)) {
      const start = m.index ?? 0
      if (at > start && at < start + m[0].length) {
        inline.add('highlight')
        highlightColor = (m[1] && colorOfEmoji(m[1])) || null
        break
      }
    }
  }

  let list: ListStyle | null = null
  if (block !== 'codeblock') {
    const heading = /^(#{1,6})\s/.exec(text)
    if (heading) block = `h${heading[1].length}` as BlockStyle
    else if (/^\s*>/.test(text)) block = 'blockquote'
    if (/^\s*[-*+]\s\[[ xX]\]\s/.test(text)) list = 'tasklist'
    else if (/^\s*[-*+]\s/.test(text)) list = 'ul'
    else if (/^\s*\d+[.)]\s/.test(text)) list = 'ol'
  }

  return { block, list, inline, highlightColor, textColor: lineColorOf(text)?.color ?? null }
}

export const BLOCK_LABELS: Record<BlockStyle, string> = {
  paragraph: 'Texte',
  h1: 'Titre 1', h2: 'Titre 2', h3: 'Titre 3', h4: 'Titre 4', h5: 'Titre 5', h6: 'Titre 6',
  blockquote: 'Citation',
  codeblock: 'Bloc de code',
}
