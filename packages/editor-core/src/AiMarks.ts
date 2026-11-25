// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Marques pour l'IA : les passages que la personne a surlignes « pour l'IA »
// et ses epingles. Elles sont a elle seule et ne sont jamais ecrites dans le
// texte de la note : ce sont des decorations, posees par l'application.
//
// Le texte brut (mode source, ligne en cours d'edition) porte une decoration
// de CodeMirror. Le texte deja rendu (paragraphe, liste, tableau : un widget)
// est surligne par l'API des surlignages du navigateur (DomHighlights.ts),
// dans les blocs que le passage traverse. L'application ajoute un trait dans
// la marge (BlockMarks.ts), visible dans tous les modes.
//
// Entre deux mises a jour, les marques suivent les modifications du texte.

import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { renderedTextRanges, setDomHighlight } from './DomHighlights'

export interface AiMarkRange {
  id: string
  from: number
  to: number
  kind: 'pin' | 'highlight'
  /** Infobulle (nom de l'epingle...). */
  title?: string
}

const setAiMarks = StateEffect.define<readonly AiMarkRange[]>()

class PinWidget extends WidgetType {
  constructor(private readonly id: string, private readonly title?: string) { super() }
  eq(other: PinWidget): boolean { return other.id === this.id && other.title === this.title }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ai-pin-point'
    span.textContent = '📌'
    span.dataset.aiMark = this.id
    if (this.title) span.title = this.title
    return span
  }
  ignoreEvent(): boolean { return true }
}

interface AiMarksState {
  ranges: readonly AiMarkRange[]
  decorations: DecorationSet
}

function decorate(ranges: readonly AiMarkRange[]): DecorationSet {
  return Decoration.set(ranges.map(r => r.to > r.from
    ? Decoration.mark({
        class: r.kind === 'pin' ? 'cm-ai-pin' : 'cm-ai-highlight',
        attributes: { 'data-ai-mark': r.id, ...(r.title ? { title: r.title } : {}) },
      }).range(r.from, r.to)
    : Decoration.widget({ widget: new PinWidget(r.id, r.title), side: 1 }).range(r.from)), true)
}

function clamp(ranges: readonly AiMarkRange[], length: number): AiMarkRange[] {
  return ranges.map(r => {
    const from = Math.max(0, Math.min(r.from, length))
    return { ...r, from, to: Math.max(from, Math.min(r.to, length)) }
  })
}

const field = StateField.define<AiMarksState>({
  create: () => ({ ranges: [], decorations: Decoration.none }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (!e.is(setAiMarks)) continue
      const ranges = clamp(e.value, tr.state.doc.length)
      return { ranges, decorations: decorate(ranges) }
    }
    if (!tr.docChanged || !value.ranges.length) return value
    const ranges = value.ranges.map(r => {
      const from = tr.changes.mapPos(r.from, 1)
      return { ...r, from, to: Math.max(from, tr.changes.mapPos(r.to, -1)) }
    })
    return { ranges, decorations: value.decorations.map(tr.changes) }
  },
  provide: f => EditorView.decorations.from(f, v => v.decorations),
})

/** Les marques en place, a jour des modifications du texte. */
export function aiMarkRanges(state: EditorState): readonly AiMarkRange[] {
  return state.field(field, false)?.ranges ?? []
}

/**
 * Ce qu'on cherche dans le texte RENDU pour une ligne de Markdown : le texte
 * sans ses marques (titre, liste, citation, gras, lien...). Approximatif : le
 * rendu d'un plugin peut afficher autre chose, et alors rien n'est surligne
 * (le trait dans la marge reste).
 */
export function renderedNeedle(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s*)*/, '')
    .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    .replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|==|`)/g, '')
    .replace(/(^|[\s(])[*_](?=\S)/g, '$1')
    .replace(/(\S)[*_](?=$|[\s.,;:!?)])/g, '$1')
    .trim()
}

const DOM_NAMES = { highlight: 'plume-ai-highlight', pin: 'plume-ai-pin' } as const

/** Le texte rendu des passages marques : surligne par le navigateur, apres le dessin. */
const renderedMarks = ViewPlugin.fromClass(class {
  constructor(readonly view: EditorView) { this.schedule() }

  update(u: ViewUpdate): void {
    const changed = u.startState.field(field) !== u.state.field(field)
    if (changed || u.docChanged || u.viewportChanged || u.selectionSet || u.geometryChanged) this.schedule()
  }

  destroy(): void {
    for (const name of Object.values(DOM_NAMES)) setDomHighlight(name, this.view, [])
  }

  private schedule(): void {
    this.view.requestMeasure({
      key: this,
      read: view => {
        const out: Record<AiMarkRange['kind'], Range[]> = { highlight: [], pin: [] }
        const { ranges } = view.state.field(field)
        for (const kind of ['highlight', 'pin'] as const) {
          const marks = ranges.filter(r => r.kind === kind && r.to > r.from)
          if (!marks.length) continue
          const blocks = Array.from(view.contentDOM.children)
          out[kind] = renderedTextRanges(view, (text, block) => {
            // Le passage du texte que ce bloc rendu affiche.
            let start: number
            let end: number
            try {
              start = view.posAtDOM(block)
              const next = blocks[blocks.indexOf(block) + 1]
              end = next ? view.posAtDOM(next) : view.state.doc.length
            } catch { return [] }
            const found: [number, number][] = []
            const hay = text
            for (const m of marks) {
              const a = Math.max(m.from, start)
              const b = Math.min(m.to, end)
              if (b <= a) continue
              let cursor = 0
              for (const line of view.state.doc.sliceString(a, b).split('\n')) {
                const needle = renderedNeedle(line)
                if (needle.length < 2) continue
                const at = hay.indexOf(needle, cursor)
                if (at < 0) continue
                found.push([at, at + needle.length])
                cursor = at + needle.length
              }
            }
            return found
          })
        }
        return out
      },
      write: (out, view) => {
        for (const kind of ['highlight', 'pin'] as const) setDomHighlight(DOM_NAMES[kind], view, out[kind])
      },
    })
  }
})

const theme = EditorView.baseTheme({
  '.cm-ai-highlight': { backgroundColor: 'rgba(34, 211, 238, 0.28)', borderBottom: '2px solid rgba(8, 145, 178, 0.85)', borderRadius: '2px' },
  '.cm-ai-pin': { backgroundColor: 'rgba(244, 114, 182, 0.18)', borderBottom: '2px dotted rgba(219, 39, 119, 0.85)', borderRadius: '2px' },
  '.cm-ai-pin-point': { fontSize: '0.8em', verticalAlign: 'super', cursor: 'default', userSelect: 'none' },
  '.cm-content ::highlight(plume-ai-highlight)': { backgroundColor: 'rgba(34, 211, 238, 0.28)' },
  '.cm-content ::highlight(plume-ai-pin)': { backgroundColor: 'rgba(244, 114, 182, 0.18)' },
})

export function aiMarksExtension(): Extension {
  return [field, renderedMarks, theme]
}

/** Remplace les marques pour l'IA (liste vide : les retire). */
export function applyAiMarks(view: EditorView, ranges: readonly AiMarkRange[]): void {
  view.dispatch({ effects: setAiMarks.of(ranges) })
}
