// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Surligner du texte deja rendu (une ligne de paragraphe, un tableau, un
// callout...). Les decorations de CodeMirror n'atteignent que le texte
// brut ; le rendu est un widget. Ici, l'API des surlignages du navigateur
// (CSS Custom Highlight : ::highlight(nom)) pose des plages sur le texte
// affiche, sans toucher au DOM. Sans cette API, seul le texte brut est
// surligne.

import type { EditorView } from '@codemirror/view'

/** Le registre des surlignages (une table nom -> Highlight), si le navigateur l'a. */
function registry(): Map<string, Highlight> | null {
  return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined'
    ? CSS.highlights as unknown as Map<string, Highlight>
    : null
}

/** Les plages de chaque editeur, par nom de surlignage (un nom vaut pour toute la page). */
const byName = new Map<string, Map<EditorView, Range[]>>()

/** Pose (ou retire, avec []) les plages d'un editeur sous le nom `name`. */
export function setDomHighlight(name: string, view: EditorView, ranges: Range[]): void {
  const reg = registry()
  if (!reg) return
  let views = byName.get(name)
  if (!views) { views = new Map(); byName.set(name, views) }
  if (ranges.length) views.set(view, ranges)
  else views.delete(view)
  const all = [...views.values()].flat()
  if (all.length) reg.set(name, new Highlight(...all))
  else reg.delete(name)
}

/** Texte brut de l'editeur (deja surligne par CodeMirror), pas du rendu. */
function isRaw(node: Node): boolean {
  const el = node.parentElement
  return !!el?.closest('.cm-line') && !el.closest('[contenteditable="false"]')
}

/**
 * Les plages du texte rendu de l'editeur ou `find` trouve quelque chose.
 * `find` recoit le texte d'un bloc rendu (et ce bloc) et rend des [debut, fin].
 */
export function renderedTextRanges(view: EditorView, find: (text: string, block: Element) => [number, number][], limit = 1000): Range[] {
  const out: Range[] = []
  for (const block of Array.from(view.contentDOM.children)) {
    let nodes: Text[] = []
    let starts: number[] = []
    let text = ''
    const flush = () => {
      if (text) {
        for (const [from, to] of find(text, block)) {
          if (out.length >= limit) break
          const at = (pos: number, end: boolean): [Text, number] => {
            let i = starts.length - 1
            while (i > 0 && (end ? starts[i] >= pos : starts[i] > pos)) i--
            return [nodes[i], pos - starts[i]]
          }
          const [sn, so] = at(from, false)
          const [en, eo] = at(to, true)
          const r = document.createRange()
          r.setStart(sn, so)
          r.setEnd(en, eo)
          out.push(r)
        }
      }
      nodes = []; starts = []; text = ''
    }
    const walk = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
    for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
      // Le texte brut coupe le bloc : on ne cherche pas a cheval dessus.
      if (isRaw(n)) { flush(); continue }
      starts.push(text.length)
      nodes.push(n)
      text += n.data
    }
    flush()
    if (out.length >= limit) break
  }
  return out
}

/** Les occurrences de `needle` dans `text`, casse ignoree ou non. */
export function plainMatches(needle: string, caseSensitive: boolean): (text: string) => [number, number][] {
  const n = caseSensitive ? needle : needle.toLowerCase()
  return text => {
    const hay = caseSensitive ? text : text.toLowerCase()
    const out: [number, number][] = []
    if (!n) return out
    for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length)) out.push([i, i + n.length])
    return out
  }
}
