// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Rechercher et remplacer dans la note (Ctrl+F, Ctrl+H), comme dans
// Obsidian : un bandeau en haut de l'editeur, les resultats surlignes dans
// le texte, « 3 sur 12 », Entree pour le suivant, Maj+Entree pour le
// precedent. Respecter la casse et expression reguliere en option.

import { EditorSelection, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, showPanel, type DecorationSet, type Panel, type ViewUpdate } from '@codemirror/view'
import { plainMatches, renderedTextRanges, setDomHighlight } from './DomHighlights'

export interface FindQuery {
  text: string
  caseSensitive: boolean
  regex: boolean
}

interface FindState {
  open: boolean
  replace: boolean
  query: FindQuery
  /** Change a chaque ouverture : le champ reprend le focus. */
  focus: number
}

const EMPTY: FindState = { open: false, replace: false, query: { text: '', caseSensitive: false, regex: false }, focus: 0 }

const setFind = StateEffect.define<Partial<FindState>>()

const findField = StateField.define<FindState>({
  create: () => EMPTY,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFind)) value = { ...value, ...e.value }
    return value
  },
  provide: f => showPanel.from(f, s => (s.open ? createPanel : null)),
})

/** Les passages qui repondent a la recherche, dans l'ordre. Max 10 000. */
export function findMatches(doc: Text | string, q: FindQuery): { from: number; to: number }[] {
  if (!q.text) return []
  const text = typeof doc === 'string' ? doc : doc.toString()
  const out: { from: number; to: number }[] = []
  if (q.regex) {
    let re: RegExp
    try { re = new RegExp(q.text, q.caseSensitive ? 'gmu' : 'gimu') } catch { return [] }
    for (let m = re.exec(text); m && out.length < 10000; m = re.exec(text)) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      out.push({ from: m.index, to: m.index + m[0].length })
    }
    return out
  }
  const hay = q.caseSensitive ? text : text.toLowerCase()
  const needle = q.caseSensitive ? q.text : q.text.toLowerCase()
  for (let i = hay.indexOf(needle); i >= 0 && out.length < 10000; i = hay.indexOf(needle, i + needle.length)) {
    out.push({ from: i, to: i + needle.length })
  }
  return out
}

/** Le texte de remplacement d'un passage ($1, $2... avec une expression reguliere). */
function replacementFor(matched: string, q: FindQuery, replace: string): string {
  if (!q.regex) return replace
  try { return matched.replace(new RegExp(q.text, q.caseSensitive ? 'mu' : 'imu'), replace) } catch { return replace }
}

function isValid(q: FindQuery): boolean {
  if (!q.regex) return true
  try { new RegExp(q.text, 'u'); return true } catch { return false }
}

// ── Surlignage des resultats ────────────────────────────────────────────────

const matchMark = Decoration.mark({ class: 'plume-find-match' })
const currentMark = Decoration.mark({ class: 'plume-find-match plume-find-current' })

/** Les resultats dans du texte rendu (le meme critere, sur le texte affiche). */
function renderedFinder(q: FindQuery): (text: string) => [number, number][] {
  if (!q.regex) return plainMatches(q.text, q.caseSensitive)
  let re: RegExp
  try { re = new RegExp(q.text, q.caseSensitive ? 'gmu' : 'gimu') } catch { return () => [] }
  return text => {
    const out: [number, number][] = []
    re.lastIndex = 0
    for (let m = re.exec(text); m && out.length < 1000; m = re.exec(text)) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      out.push([m.index, m.index + m[0].length])
    }
    return out
  }
}

const findHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet = Decoration.none
  private matches: { from: number; to: number }[] = []
  constructor(readonly view: EditorView) { this.compute(view, true) }
  destroy() { setDomHighlight('plume-find-match', this.view, []) }
  update(u: ViewUpdate) {
    const before = u.startState.field(findField)
    const now = u.state.field(findField)
    const queryChanged = before.query !== now.query || before.open !== now.open
    if (queryChanged || u.docChanged || u.viewportChanged || u.selectionSet) this.compute(u.view, queryChanged || u.docChanged)
  }
  compute(view: EditorView, recount: boolean) {
    const s = view.state.field(findField)
    if (!s.open || !s.query.text) {
      this.matches = []
      this.decorations = Decoration.none
      setDomHighlight('plume-find-match', view, [])
      return
    }
    if (recount) this.matches = findMatches(view.state.doc, s.query)
    const main = view.state.selection.main
    const marks = []
    for (const { from, to } of view.visibleRanges) {
      for (const m of this.matches) {
        if (m.to < from) continue
        if (m.from > to) break
        marks.push((m.from === main.from && m.to === main.to ? currentMark : matchMark).range(m.from, m.to))
      }
    }
    this.decorations = Decoration.set(marks, true)
    // Apres le dessin : les resultats dans le texte rendu.
    view.requestMeasure({
      key: this,
      read: v => (s.open && s.query.text ? renderedTextRanges(v, renderedFinder(s.query)) : []),
      write: (ranges, v) => setDomHighlight('plume-find-match', v, ranges),
    })
  }
}, { decorations: v => v.decorations })

// ── Aller d'un resultat a l'autre, remplacer ────────────────────────────────

function select(view: EditorView, m: { from: number; to: number }): void {
  view.dispatch({
    selection: EditorSelection.range(m.from, m.to),
    effects: EditorView.scrollIntoView(m.from, { y: 'center' }),
    userEvent: 'select.search',
  })
}

/** Le resultat suivant (dir 1) ou precedent (-1), en bouclant. */
export function findNext(view: EditorView, dir: 1 | -1 = 1): boolean {
  const { query } = view.state.field(findField)
  const matches = findMatches(view.state.doc, query)
  if (matches.length === 0) return false
  const main = view.state.selection.main
  const m = dir === 1
    ? matches.find(x => x.from >= main.to && !(x.from === main.from && x.to === main.to)) ?? matches[0]
    : [...matches].reverse().find(x => x.to <= main.from) ?? matches[matches.length - 1]
  select(view, m)
  return true
}

/** Remplace le resultat selectionne, puis va au suivant. */
export function replaceNext(view: EditorView, replace: string): boolean {
  const { query } = view.state.field(findField)
  const matches = findMatches(view.state.doc, query)
  const main = view.state.selection.main
  const current = matches.find(x => x.from === main.from && x.to === main.to)
  if (!current) return findNext(view)
  const insert = replacementFor(view.state.sliceDoc(current.from, current.to), query, replace)
  view.dispatch({ changes: { from: current.from, to: current.to, insert }, selection: EditorSelection.cursor(current.from + insert.length), userEvent: 'input.replace' })
  findNext(view)
  return true
}

/** Remplace tous les resultats (une seule modification, annulable). */
export function replaceAll(view: EditorView, replace: string): number {
  const { query } = view.state.field(findField)
  const matches = findMatches(view.state.doc, query)
  if (matches.length === 0) return 0
  const changes = matches.map(m => ({ from: m.from, to: m.to, insert: replacementFor(view.state.sliceDoc(m.from, m.to), query, replace) }))
  view.dispatch({ changes, userEvent: 'input.replace.all' })
  return matches.length
}

/** Ouvre la recherche (avec le remplacement si `replace`), le texte selectionne comme recherche. */
export function openFind(view: EditorView, replace = false): boolean {
  const s = view.state.field(findField, false)
  if (!s) return false
  const main = view.state.selection.main
  const picked = view.state.sliceDoc(main.from, main.to)
  const query = !main.empty && !picked.includes('\n') && picked.length <= 200 ? { ...s.query, text: picked } : s.query
  view.dispatch({ effects: setFind.of({ open: true, replace: replace || (s.open && s.replace), query, focus: s.focus + 1 }) })
  return true
}

export function closeFind(view: EditorView): boolean {
  const s = view.state.field(findField, false)
  if (!s?.open) return false
  view.dispatch({ effects: setFind.of({ open: false }) })
  view.focus()
  return true
}

// ── Le bandeau ──────────────────────────────────────────────────────────────

function createPanel(view: EditorView): Panel {
  const dom = document.createElement('div')
  dom.className = 'plume-find'
  dom.dataset.testid = 'find-panel'
  const row = (cls: string) => {
    const r = document.createElement('div')
    r.className = `plume-find-row ${cls}`
    dom.appendChild(r)
    return r
  }
  const button = (parent: HTMLElement, label: string, title: string, run: () => void, testid?: string) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'plume-find-button'
    b.textContent = label
    b.title = title
    if (testid) b.dataset.testid = testid
    b.addEventListener('mousedown', e => e.preventDefault())
    b.addEventListener('click', run)
    parent.appendChild(b)
    return b
  }
  const toggle = (parent: HTMLElement, label: string, title: string, key: 'caseSensitive' | 'regex') => {
    const b = button(parent, label, title, () => {
      const q = view.state.field(findField).query
      view.dispatch({ effects: setFind.of({ query: { ...q, [key]: !q[key] } }) })
    }, `find-${key}`)
    b.classList.add('plume-find-toggle')
    return b
  }

  const top = row('plume-find-main')
  const field = document.createElement('input')
  field.className = 'plume-find-input'
  field.placeholder = 'Rechercher'
  field.dataset.testid = 'find-input'
  field.spellcheck = false
  top.appendChild(field)
  const count = document.createElement('span')
  count.className = 'plume-find-count'
  count.dataset.testid = 'find-count'
  top.appendChild(count)
  const caseBtn = toggle(top, 'Aa', 'Respecter la casse', 'caseSensitive')
  const regexBtn = toggle(top, '.*', 'Expression régulière', 'regex')
  button(top, '↑', 'Précédent (Maj+Entrée)', () => findNext(view, -1), 'find-prev')
  button(top, '↓', 'Suivant (Entrée)', () => findNext(view, 1), 'find-next')
  const replaceToggle = button(top, '⇄', 'Remplacer (Ctrl+H)', () => {
    const s = view.state.field(findField)
    view.dispatch({ effects: setFind.of({ replace: !s.replace }) })
    if (!s.replace) queueMicrotask(() => replaceField.focus())
  }, 'find-toggle-replace')
  replaceToggle.classList.add('plume-find-toggle')
  button(top, '×', 'Fermer (Échap)', () => closeFind(view), 'find-close')

  const bottom = row('plume-find-replace')
  const replaceField = document.createElement('input')
  replaceField.className = 'plume-find-input'
  replaceField.placeholder = 'Remplacer par'
  replaceField.dataset.testid = 'replace-input'
  replaceField.spellcheck = false
  bottom.appendChild(replaceField)
  button(bottom, 'Remplacer', 'Remplacer ce résultat (Entrée)', () => replaceNext(view, replaceField.value), 'replace-one')
  button(bottom, 'Tout remplacer', 'Remplacer partout (Ctrl+Alt+Entrée)', () => replaceAll(view, replaceField.value), 'replace-all')

  let lastFocus = -1
  const refresh = () => {
    const s = view.state.field(findField)
    if (field.value !== s.query.text) field.value = s.query.text
    caseBtn.classList.toggle('plume-find-on', s.query.caseSensitive)
    regexBtn.classList.toggle('plume-find-on', s.query.regex)
    replaceToggle.classList.toggle('plume-find-on', s.replace)
    bottom.hidden = !s.replace || view.state.readOnly
    const valid = isValid(s.query)
    field.classList.toggle('plume-find-invalid', !valid)
    const matches = findMatches(view.state.doc, s.query)
    const main = view.state.selection.main
    const index = matches.findIndex(m => m.from === main.from && m.to === main.to)
    count.textContent = !s.query.text ? '' : !valid ? 'Expression invalide'
      : matches.length === 0 ? 'Aucun résultat'
      : index >= 0 ? `${index + 1} sur ${matches.length}` : `${matches.length} résultat${matches.length > 1 ? 's' : ''}`
    if (s.focus !== lastFocus) {
      lastFocus = s.focus
      queueMicrotask(() => { field.focus(); field.select() })
    }
  }

  field.addEventListener('input', () => {
    const q = view.state.field(findField).query
    view.dispatch({ effects: setFind.of({ query: { ...q, text: field.value } }) })
    // Le premier resultat a partir du curseur, pendant la frappe.
    const matches = findMatches(view.state.doc, view.state.field(findField).query)
    const head = view.state.selection.main.from
    const m = matches.find(x => x.from >= head) ?? matches[0]
    if (m) select(view, m)
  })
  const keys = (e: KeyboardEvent, onEnter: () => void) => {
    if (e.key === 'Escape') { e.preventDefault(); closeFind(view) }
    else if (e.key === 'Enter') { e.preventDefault(); onEnter() }
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); field.focus(); field.select() }
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'h' || e.key === 'H')) { e.preventDefault(); openFind(view, true); queueMicrotask(() => replaceField.focus()) }
  }
  field.addEventListener('keydown', e => keys(e, () => findNext(view, e.shiftKey ? -1 : 1)))
  replaceField.addEventListener('keydown', e => keys(e, () => {
    if ((e.ctrlKey || e.metaKey) && e.altKey) replaceAll(view, replaceField.value)
    else replaceNext(view, replaceField.value)
  }))

  refresh()
  return {
    dom,
    top: true,
    update(u) {
      if (u.docChanged || u.selectionSet || u.startState.field(findField) !== u.state.field(findField)) refresh()
    },
  }
}

const theme = EditorView.baseTheme({
  '.cm-panels-top': { borderBottom: '1px solid var(--border, #3d3d5c)', background: 'var(--bg-elevated, #252535)' },
  '.plume-find': { display: 'flex', flexDirection: 'column', gap: '6px', padding: '6px 10px', font: '13px var(--font-ui, system-ui)' },
  '.plume-find-row': { display: 'flex', alignItems: 'center', gap: '4px' },
  '.plume-find-row[hidden]': { display: 'none' },
  '.plume-find-input': {
    flex: '1 1 auto', minWidth: '120px', maxWidth: '360px', padding: '3px 8px', borderRadius: '4px',
    border: '1px solid var(--border, #3d3d5c)', background: 'var(--bg-surface, transparent)', color: 'var(--text, inherit)', font: 'inherit',
  },
  '.plume-find-input:focus': { outline: 'none', borderColor: 'var(--accent, #7c3aed)' },
  '.plume-find-invalid': { borderColor: '#e5484d !important' },
  '.plume-find-count': { minWidth: '88px', padding: '0 6px', color: 'var(--text-faint, #888)', fontSize: '12px', whiteSpace: 'nowrap' },
  '.plume-find-button': {
    minWidth: '26px', height: '26px', padding: '0 7px', borderRadius: '4px', border: '1px solid transparent',
    background: 'transparent', color: 'var(--text-muted, inherit)', font: 'inherit', cursor: 'pointer',
  },
  '.plume-find-button:hover': { background: 'var(--bg-hover, rgba(127,127,127,.15))' },
  '.plume-find-on': { borderColor: 'var(--accent, #7c3aed)', color: 'var(--accent, #7c3aed)' },
  '.plume-find-match': { background: 'rgba(250, 204, 21, 0.35)', borderRadius: '2px' },
  '.cm-content ::highlight(plume-find-match)': { backgroundColor: 'rgba(250, 204, 21, 0.45)' },
  '.plume-find-current': { background: 'rgba(249, 115, 22, 0.6)', boxShadow: '0 0 0 1px rgba(249, 115, 22, 0.9)' },
})

export const findReplace: Extension = [findField, findHighlight, theme]
