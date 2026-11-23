// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Marques de blocs, posees par l'application : un trait dans la marge le long
// d'un bloc (« modifie depuis votre derniere visite », « en lecture par
// l'agent »...), et parfois une pastille, au debut du bloc, qui s'ouvre sur
// un court texte et des boutons (un conseil d'un agent en veille).
//
// Tout est dessine dans une GOUTTIERE (colonne a gauche du texte), pas dans
// les lignes : en mode « power » et « classique », un paragraphe qui n'est
// pas en cours d'edition est rendu par un widget qui remplace ses lignes ;
// une decoration de ligne y disparaitrait. La gouttiere, elle, a une case
// par ligne de texte ET par widget.
//
// Plusieurs sources posent leurs marques sans se gener : chacune a son nom
// (`owner`) et remplace seulement les siennes. Les marques suivent les
// modifications du texte jusqu'a leur prochaine mise a jour.

import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { GutterMarker, gutter, type EditorView } from '@codemirror/view'

export interface BlockMarkAction {
  label: string
  run(): void
}

export interface BlockMark {
  from: number
  to: number
  /** Classe du trait dans la marge (sa couleur). */
  className: string
  /** Infobulle du trait. */
  title?: string
  /** Pastille au debut du bloc : un texte court, ouvert au clic. */
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

/** Les marques de chaque source ; leurs positions suivent le texte. */
const field = StateField.define<ReadonlyMap<string, readonly BlockMark[]>>({
  create: () => new Map(),
  update(value, tr) {
    let next: Map<string, readonly BlockMark[]> | null = null
    if (tr.docChanged) {
      next = new Map()
      for (const [owner, marks] of value) {
        next.set(owner, marks.map(m => {
          const from = tr.changes.mapPos(m.from, 1)
          return { ...m, from, to: Math.max(from, tr.changes.mapPos(m.to, -1)) }
        }))
      }
    }
    for (const e of tr.effects) {
      if (!e.is(setMarks)) continue
      next ??= new Map(value)
      if (e.value.marks.length) next.set(e.value.owner, e.value.marks)
      else next.delete(e.value.owner)
    }
    return next ?? value
  },
})

function badgeDOM(badge: NonNullable<BlockMark['badge']>): HTMLElement {
  const wrap = document.createElement('span')
  wrap.className = `cm-block-badge ${badge.className ?? ''}`.trim()
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'cm-block-badge-button'
  button.textContent = badge.label
  button.title = badge.text
  const panel = document.createElement('span')
  panel.className = 'cm-block-badge-panel'
  panel.hidden = true
  const text = document.createElement('span')
  text.className = 'cm-block-badge-text'
  text.textContent = badge.text
  panel.appendChild(text)
  for (const action of badge.actions ?? []) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'cm-block-badge-action'
    b.textContent = action.label
    b.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation() })
    b.addEventListener('click', e => { e.stopPropagation(); action.run() })
    panel.appendChild(b)
  }
  // Garder le curseur ou il est : la pastille n'est pas du texte.
  button.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation() })
  button.addEventListener('click', e => { e.stopPropagation(); panel.hidden = !panel.hidden; wrap.classList.toggle('is-open', !panel.hidden) })
  wrap.append(button, panel)
  return wrap
}

/** La case de gouttiere d'une ligne (ou d'un widget) : ses traits, et les pastilles des blocs qui y commencent. */
class MarksMarker extends GutterMarker {
  constructor(
    private readonly bars: readonly { className: string; title?: string }[],
    private readonly badges: readonly NonNullable<BlockMark['badge']>[],
  ) { super() }

  private key(): string {
    return JSON.stringify([this.bars, this.badges.map(b => [b.label, b.text, b.actions?.length ?? 0])])
  }

  eq(other: GutterMarker): boolean {
    return other instanceof MarksMarker && other.key() === this.key()
  }

  toDOM(): HTMLElement {
    const box = document.createElement('div')
    box.className = 'cm-block-mark'
    for (const bar of this.bars) {
      const el = document.createElement('span')
      el.className = `cm-block-mark-bar ${bar.className}`
      if (bar.title) el.title = bar.title
      box.appendChild(el)
    }
    for (const badge of this.badges) box.appendChild(badgeDOM(badge))
    return box
  }
}

/** Ce qu'il faut dessiner pour le passage [from, to] (une ligne, ou les lignes d'un widget). */
function markerFor(view: EditorView, from: number, to: number): MarksMarker | null {
  const bars: { className: string; title?: string }[] = []
  const badges: NonNullable<BlockMark['badge']>[] = []
  for (const marks of view.state.field(field).values()) {
    for (const m of marks) {
      if (m.to < from || m.from > to) continue
      if (!bars.some(b => b.className === m.className)) bars.push({ className: m.className, ...(m.title ? { title: m.title } : {}) })
      // La pastille va sur la case ou le bloc commence.
      if (m.badge && m.from >= from && m.from <= to) badges.push(m.badge)
    }
  }
  return bars.length || badges.length ? new MarksMarker(bars, badges) : null
}

const marksGutter = gutter({
  class: 'cm-block-marks',
  lineMarker: (view, line) => markerFor(view, line.from, line.to),
  // Un widget pose entre deux lignes (espace avant un titre) : la marque est sur la ligne.
  widgetMarker: (view, _widget, block) => (block.from === block.to ? null : markerFor(view, block.from, block.to)),
  lineMarkerChange: update => update.docChanged || update.transactions.some(tr => tr.effects.some(e => e.is(setMarks))),
})

export function blockMarksExtension(): Extension {
  return [field, marksGutter]
}

/** Remplace les marques d'une source (liste vide : les retire). */
export function applyBlockMarks(view: EditorView, owner: string, marks: readonly BlockMark[]): void {
  view.dispatch({ effects: setMarks.of({ owner, marks }) })
}

/** Les marques en place (tests, outils). */
export function blockMarksOf(view: EditorView): ReadonlyMap<string, readonly BlockMark[]> {
  return view.state.field(field)
}
