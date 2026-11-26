// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Glisser un fichier de l'explorateur dans une note y met une reference,
// comme Obsidian : `[[Note]]` pour une note ou un autre fichier, `![[x.png]]`
// pour une image, une video ou un son (sur sa propre ligne, pour etre rendue).
// Le texte du lien (nom seul s'il est unique, sinon chemin) vient de l'hote.

import { EditorSelection, type Extension, type Text } from '@codemirror/state'
import { EditorView, ViewPlugin, dropCursor } from '@codemirror/view'
import { imageInsertion } from './ImageInsert'

/** Type des donnees glissees depuis l'explorateur : le chemin du fichier. */
export const FILE_PATH_DRAG_TYPE = 'text/x-poc-file-path'

const EMBED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif',
  'mp4', 'm4v', 'webm', 'mov', 'ogv', 'mp3', 'wav', 'ogg', 'oga', 'm4a', 'flac',
])

/** Un fichier qu'on integre (`![[...]]`) plutot qu'on ne lie. */
export function isEmbeddedOnDrop(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && EMBED_EXTS.has(name.slice(dot + 1).toLowerCase())
}

/** Glisse-t-on un fichier de l'explorateur ? (le chemin n'est lisible qu'au depot) */
export function isFileDrag(event: DragEvent): boolean {
  return !!event.dataTransfer?.types.includes(FILE_PATH_DRAG_TYPE)
}

/**
 * Texte a inserer a `pos` pour une reference a `target`. Un lien prend des
 * espaces s'il touche un mot ; une integration a sa propre ligne.
 */
export function fileReferenceInsertion(doc: Text, pos: number, target: string, embed: boolean): { from: number; insert: string; cursor: number } {
  if (embed) return imageInsertion(doc, pos, [target])!
  const at = Math.max(0, Math.min(pos, doc.length))
  const before = at > 0 ? doc.sliceString(at - 1, at) : ''
  const after = doc.sliceString(at, at + 1)
  const link = `[[${target}]]`
  const insert = (before && !/\s/.test(before) ? ' ' : '') + link + (after && !/\s/.test(after) ? ' ' : '')
  return { from: at, insert, cursor: at + insert.length }
}

/** Debut du texte d'une ligne, apres son marqueur (puce, numero, case, `>`, `#`). */
const LINE_MARK_RE = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|(?:>\s?)+|#{1,6}\s+)?/

/**
 * Position dans la source `line` qui suit le texte affiche `shown`. Le texte
 * affiche est la source sans sa mise en forme (`**`, `[[`, url...) : on les
 * aligne caractere par caractere, en sautant ce qui ne s'affiche pas. Null
 * si l'alignement echoue.
 */
export function sourceOffsetForShown(line: string, shown: string): number | null {
  let i = LINE_MARK_RE.exec(line)?.[0].length ?? 0
  const text = shown.replace(/\s+/g, ' ')
  for (let j = 0; j < text.length; j++) {
    const c = text[j]
    while (i < line.length && !(line[i] === c || (c === ' ' && /\s/.test(line[i])))) i++
    if (i >= line.length) return null
    i++
  }
  return i
}

/**
 * Ou tombe un depot. Une ligne rendue (pas en edition) est un seul bloc pour
 * l'editeur, qui ne rendrait que son debut : on retrouve la place dans son
 * texte affiche, puis dans sa source.
 */
function dropPosition(view: EditorView, x: number, y: number): number {
  const pos = view.posAtCoords({ x, y }, false)
  const hit = document.elementFromPoint(x, y)
  const block = hit?.closest('.vault-rendered-block')
  if (!block || !view.contentDOM.contains(block)) return pos
  let from: number
  try { from = view.posAtDOM(block) } catch { return pos }
  const line = view.state.doc.lineAt(from)
  // Un vrai bloc (tableau, liste d'un tenant...) : sa position, sans plus.
  if (line.from !== from || line.to < from) return pos
  const doc = document as Document & { caretPositionFromPoint?(x: number, y: number): { offsetNode: Node; offset: number } | null }
  const caret = doc.caretPositionFromPoint?.(x, y)
  const range = document.createRange()
  if (caret) range.setEnd(caret.offsetNode, caret.offset)
  else {
    const r = document.caretRangeFromPoint?.(x, y)
    if (!r) return pos
    range.setEnd(r.startContainer, r.startOffset)
  }
  if (!block.contains(range.endContainer)) return pos
  // La puce ou le numero ne sont pas du texte de la ligne.
  const content = block.querySelector('.vault-list-content')
  const start = content && content.contains(range.endContainer) ? content : block
  range.setStart(start, 0)
  const offset = sourceOffsetForShown(line.text, range.toString())
  return offset === null ? line.to : line.from + offset
}

/**
 * Deposer un fichier de l'explorateur dans la note. `linkTarget` : texte du
 * lien pour un chemin. Ecoute tout l'editeur (texte, marges, gouttiere), pas
 * seulement le texte : un depot a cote d'une ligne la vise aussi.
 */
export function fileDropExtension(linkTarget: (path: string) => string): Extension {
  const plugin = ViewPlugin.fromClass(class {
    constructor(readonly view: EditorView) {
      view.dom.addEventListener('dragover', this.over)
      view.dom.addEventListener('drop', this.drop)
    }
    over = (event: DragEvent) => {
      if (!isFileDrag(event) || this.view.state.readOnly) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'link'
    }
    drop = (event: DragEvent) => {
      const view = this.view
      if (!isFileDrag(event) || view.state.readOnly) return
      const path = event.dataTransfer?.getData(FILE_PATH_DRAG_TYPE)
      if (!path) return
      event.preventDefault()
      // L'espace des panneaux ne l'ouvre pas en plus.
      event.stopPropagation()
      const pos = dropPosition(view, event.clientX, event.clientY)
      const { from, insert, cursor } = fileReferenceInsertion(view.state.doc, pos, linkTarget(path), isEmbeddedOnDrop(path))
      view.dispatch({
        changes: { from, insert },
        selection: EditorSelection.cursor(cursor),
        scrollIntoView: true,
        userEvent: 'input.drop',
      })
      view.focus()
    }
    destroy() {
      this.view.dom.removeEventListener('dragover', this.over)
      this.view.dom.removeEventListener('drop', this.drop)
    }
  })
  return [dropCursor(), plugin]
}
