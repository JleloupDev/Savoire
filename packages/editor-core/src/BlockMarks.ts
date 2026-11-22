// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Marques de blocs, posees par l'application : un trait dans la marge le long
// d'un bloc (« modifie depuis votre derniere visite », « en lecture par
// l'agent »...), et parfois une pastille en fin de bloc qui s'ouvre sur un
// court texte et des boutons (un conseil d'un agent en veille).
//
// Plusieurs sources posent leurs marques sans se gener : chacune a son nom
// (`owner`) et remplace seulement les siennes. Les marques suivent les
// modifications du texte jusqu'a leur prochaine mise a jour.

import { RangeSet, StateEffect, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

export interface BlockMarkAction {
  label: string
  run(): void
}

export interface BlockMark {
  from: number
  to: number
  /** Classe des lignes du bloc (couleur du trait dans la marge). */
  className: string
  /** Infobulle des lignes. */
  title?: string
  /** Pastille en fin de bloc : un texte court, ouvert au clic. */
  badge?: {
    /** Libelle de la pastille (une icone, un mot). */
    label: string
    /** Texte montre a l'ouverture. */
    text: string
    className?: string
    actions?: BlockMarkAction[]
  }
}

const setMarks = StateEffect.define<{ owner: string; marks: readonly BlockMark[] }>()

class Badge extends WidgetType {
  constructor(private readonly badge: NonNullable<BlockMark['badge']>) { super() }

  eq(other: Badge): boolean {
    return other.badge.label === this.badge.label && other.badge.text === this.badge.text
      && (other.badge.actions?.length ?? 0) === (this.badge.actions?.length ?? 0)
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = `cm-block-badge ${this.badge.className ?? ''}`.trim()
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'cm-block-badge-button'
    button.textContent = this.badge.label
    button.title = this.badge.text
    const panel = document.createElement('span')
    panel.className = 'cm-block-badge-panel'
    panel.hidden = true
    const text = document.createElement('span')
    text.className = 'cm-block-badge-text'
    text.textContent = this.badge.text
    panel.appendChild(text)
    for (const action of this.badge.actions ?? []) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'cm-block-badge-action'
      b.textContent = action.label
      b.addEventListener('mousedown', e => e.preventDefault())
      b.addEventListener('click', e => { e.stopPropagation(); action.run() })
      panel.appendChild(b)
    }
    // Garder le curseur ou il est : la pastille n'est pas du texte.
    button.addEventListener('mousedown', e => e.preventDefault())
    button.addEventListener('click', e => { e.stopPropagation(); panel.hidden = !panel.hidden; wrap.classList.toggle('is-open', !panel.hidden) })
    wrap.append(button, panel)
    return wrap
  }

  ignoreEvent(): boolean { return true }
}

type Doc = { length: number; lineAt(pos: number): { number: number }; line(n: number): { from: number } }

function build(marks: readonly BlockMark[], doc: Doc): DecorationSet {
  const len = doc.length
  const ranges: Range<Decoration>[] = []
  for (const m of marks) {
    const from = Math.max(0, Math.min(m.from, len))
    const to = Math.max(from, Math.min(m.to, len))
    const first = doc.lineAt(from).number
    const last = doc.lineAt(to).number
    const line = Decoration.line({ class: m.className, ...(m.title ? { attributes: { title: m.title } } : {}) })
    for (let n = first; n <= last; n++) ranges.push(line.range(doc.line(n).from))
    if (m.badge) ranges.push(Decoration.widget({ widget: new Badge(m.badge), side: 1 }).range(to))
  }
  return Decoration.set(ranges, true)
}

/** Les marques de chaque source, deja dessinees ; chacune suit le texte. */
const field = StateField.define<ReadonlyMap<string, DecorationSet>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<string, DecorationSet> | null = null
    if (tr.docChanged) {
      next = new Map()
      for (const [owner, deco] of value) next.set(owner, deco.map(tr.changes))
    }
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue
      next ??= new Map(value)
      if (e.value.marks.length) next.set(e.value.owner, build(e.value.marks, tr.state.doc))
      else next.delete(e.value.owner)
    }
    return next ?? value
  },
  provide: f => EditorView.decorations.from(f, v => RangeSet.join([...v.values()])),
})

export function blockMarksExtension(): Extension {
  return field
}

/** Remplace les marques d'une source (liste vide : les retire). */
export function applyBlockMarks(view: EditorView, owner: string, marks: readonly BlockMark[]): void {
  view.dispatch({ effects: setMarks.of({ owner, marks }) })
}
