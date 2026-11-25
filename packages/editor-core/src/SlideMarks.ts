// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Dans une note `type: slides`, l'editeur montre ou commence chaque
// diapositive (« Diapositive 3 », avec un bouton pour presenter a partir
// d'elle) et met les notes du presentateur en retrait. Rien ne change dans
// les autres notes.
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { isSlidesNote, slideDeck } from '@savoire/plugin-api'

export interface SlideMarksOptions {
  /** Presente a partir de la diapositive `index` (a partir de 0). */
  present(index: number): void
}

class SlideLabel extends WidgetType {
  constructor(private readonly index: number, private readonly count: number, private readonly title: string, private readonly opts: SlideMarksOptions) { super() }

  eq(other: SlideLabel): boolean {
    return other.index === this.index && other.count === this.count && other.title === this.title
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'plume-slide-mark'
    el.dataset.testid = 'plume-slide-mark'
    el.contentEditable = 'false'
    const label = document.createElement('span')
    label.className = 'plume-slide-mark-label'
    label.textContent = `Diapositive ${this.index + 1} / ${this.count}`
    const play = document.createElement('button')
    play.type = 'button'
    play.className = 'plume-slide-mark-play'
    play.textContent = '▶ Présenter'
    play.title = this.index === 0 ? 'Présenter depuis le début (F5)' : 'Présenter à partir de cette diapositive (Maj+F5)'
    play.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation() })
    play.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); this.opts.present(this.index) })
    el.append(label, play)
    return el
  }

  ignoreEvent(): boolean {
    return true
  }
}

const notesLine = Decoration.line({ class: 'plume-slide-notes' })
const notesHead = Decoration.line({ class: 'plume-slide-notes plume-slide-notes-head' })
// Reglages d'une diapositive (`<!-- transition: zoom -->`) et pauses (`. . .`) : discrets.
const settingLine = Decoration.line({ class: 'plume-slide-setting' })
const pauseLine = Decoration.line({ class: 'plume-slide-pause' })
const SETTING_RE = /^[ \t]*<!--[^>]*:[\s\S]*-->[ \t]*$/
const PAUSE_RE = /^[ \t]*\.[ \t]\.[ \t]\.[ \t]*$/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

function build(state: EditorState, opts: SlideMarksOptions): DecorationSet {
  const text = state.doc.toString()
  if (!isSlidesNote(text)) return Decoration.none
  const deck = slideDeck(text)
  const ranges: Range<Decoration>[] = []
  const count = deck.slides.length
  for (const s of deck.slides) {
    // L'etiquette se pose au debut de la premiere ligne de la diapositive.
    const at = Math.min(s.from, state.doc.length)
    const line = state.doc.lineAt(at)
    ranges.push(Decoration.widget({ widget: new SlideLabel(s.index, count, s.title, opts), block: true, side: -1 }).range(line.from))
    const end = Math.min(state.doc.length, s.notesFrom >= 0 ? s.notesFrom : s.to)
    let fence = false
    for (let n = line.number; n <= state.doc.lineAt(end).number; n++) {
      const l = state.doc.line(n)
      if (l.from >= end && n > line.number) break
      if (FENCE_RE.test(l.text)) { fence = !fence; continue }
      if (fence) continue
      if (SETTING_RE.test(l.text)) ranges.push(settingLine.range(l.from))
      else if (PAUSE_RE.test(l.text)) ranges.push(pauseLine.range(l.from))
    }
    if (s.notesFrom >= 0) {
      const first = state.doc.lineAt(s.notesFrom).number
      const last = state.doc.lineAt(Math.max(s.notesFrom, Math.min(state.doc.length, s.to - 1))).number
      for (let n = first; n <= last; n++) ranges.push((n === first ? notesHead : notesLine).range(state.doc.line(n).from))
    }
  }
  return Decoration.set(ranges, true)
}

const THEME = EditorView.baseTheme({
  '.plume-slide-mark': {
    display: 'flex', alignItems: 'center', gap: '8px', margin: '18px 0 6px',
    padding: '3px 0', borderTop: '2px dashed var(--border, #d0d7de)',
    fontFamily: 'var(--font-ui, system-ui, sans-serif)', fontSize: '12px', color: 'var(--text-muted, #57606a)',
    userSelect: 'none',
  },
  '.plume-slide-mark-label': { fontWeight: '600', letterSpacing: '.02em', textTransform: 'uppercase' },
  '.plume-slide-mark-play': {
    marginLeft: 'auto', border: '1px solid var(--border, #d0d7de)', borderRadius: '5px', background: 'transparent',
    color: 'inherit', font: 'inherit', padding: '1px 8px', cursor: 'pointer', opacity: '0.75',
  },
  '.plume-slide-mark-play:hover': { opacity: '1', color: 'var(--accent, #2563eb)', borderColor: 'currentColor' },
  '.plume-slide-notes': { color: 'var(--text-muted, #57606a)', fontSize: '0.92em', borderLeft: '3px solid var(--border, #d0d7de)', paddingLeft: '10px !important' },
  '.plume-slide-notes-head': { fontStyle: 'italic' },
  '.plume-slide-setting, .plume-slide-setting *': { color: 'var(--text-faint, #8b949e) !important', fontFamily: 'var(--font-ui, system-ui, sans-serif) !important', fontSize: '12px !important' },
  '.plume-slide-pause, .plume-slide-pause *': { color: 'var(--accent, #2563eb) !important', letterSpacing: '.3em', fontWeight: '700' },
})

/** Les marques des diapositives, pour une note Markdown. */
export function slideMarksExtension(opts: SlideMarksOptions): Extension {
  const field = StateField.define<DecorationSet>({
    create: state => build(state, opts),
    update: (value, tr) => (tr.docChanged ? build(tr.state, opts) : value),
    provide: f => EditorView.decorations.from(f),
  })
  return [field, THEME]
}
