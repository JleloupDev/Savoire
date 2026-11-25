// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Marques pour l'IA : ce que la personne designe a ChatGPT, Claude ou
// l'assistant, sans rien ecrire dans la note.
//
//  - « Épingler pour l'IA » fige la selection (ou l'endroit du curseur) sous
//    un nom : une epingle, qui reste (outil list_pins) ;
//  - « Surligner pour l'IA » marque un ou plusieurs passages, jusqu'a
//    « Effacer les surlignages IA » (rendus avec get_context).
//
// Elles sont personnelles et gardees sur le serveur (ai_marks) : profil
// serveur seulement, jamais pour un vault chiffre de bout en bout. Dans la
// note, ce sont des decorations de l'editeur et un trait dans la marge, avec
// une pastille pour les retirer.
import type { AiMark, EditorAnchor } from '@savoire/agent-core'
import type { AiMarkRange, BlockMark } from '@savoire/editor-core'
import { notify } from '@savoire/notifications'
import { aiEditor, aiServer, anchorOf, locateAnchor, onAiEditorChange, withNoteText } from './aiContext'

const OWNER = 'ai-marks'
/** Le texte d'un passage marque a change : on attend que la frappe se pose avant de le dire au serveur. */
const QUOTE_REFRESH_MS = 3000
const RENDER_DELAY_MS = 300

let marks: AiMark[] = []
/** Le compte dont les marques sont chargees. */
let loadedFor: string | null = null
/** Dernier chargement rate : on ne reessaie pas a chaque rendu de l'appli. */
let failedAt = 0
const RETRY_AFTER_MS = 10_000
let stopEditor: (() => void) | null = null
let renderTimer: ReturnType<typeof setTimeout> | null = null
let refreshTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload() })

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const s = aiServer()
  if (!s) throw new Error('Les marques pour l’IA demandent un vault synchronisé par le serveur Savoire.')
  const res = await fetch(s.url(`/api/v1/me/ai-marks${path}`), {
    method,
    headers: { Authorization: `Bearer ${s.token()}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  if (!res.ok) {
    const p = await res.json().catch(() => null) as { detail?: string; title?: string } | null
    throw new Error(p?.detail ?? p?.title ?? `Erreur ${res.status}`)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

function changed(): void {
  render()
  for (const cb of [...listeners]) cb()
}

/** Les marques de la personne (toutes ses notes). */
export function aiMarks(): readonly AiMark[] {
  return marks
}

export function onAiMarksChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Charge les marques du compte (une fois par compte ; `force` : les relire). */
export async function loadAiMarks(accountId: string | null, force = false): Promise<void> {
  if (!accountId || !aiServer()) {
    loadedFor = null
    if (marks.length) { marks = []; changed() }
    return
  }
  if (loadedFor === accountId && !force) return
  if (!force && Date.now() - failedAt < RETRY_AFTER_MS) return
  loadedFor = accountId
  try {
    const r = await call<{ marks: AiMark[] }>('GET', '')
    if (loadedFor !== accountId) return
    marks = r.marks
    changed()
  } catch (err) {
    loadedFor = null
    failedAt = Date.now()
    console.warn('[aiMarks] chargement impossible', err)
  }
}

interface Located { mark: AiMark; from: number; to: number; current: string }

/** Les marques de la note active, la ou elles sont aujourd'hui dans le texte. */
function locate(): { located: Located[]; docId: string } | null {
  const a = aiEditor()
  const docId = a?.docId()
  const session = a?.session()
  if (!a?.editor || !docId || !session) return null
  const mine = marks.filter(m => m.docId === docId)
  if (!mine.length) return { located: [], docId }
  const located = withNoteText(session, docId, text => mine.flatMap(mark => {
    const at = locateAnchor(text, mark.anchor)
    return at ? [{ mark, ...at, current: text.slice(at.from, at.to) }] : []
  })) ?? []
  return { located, docId }
}

function describe(m: AiMark): string {
  if (m.kind === 'pin') return `Épingle pour l’IA : « ${m.label} »`
  return 'Passage surligné pour l’IA'
}

/** Dessine les marques de la note active : decorations et traits dans la marge. */
function render(): void {
  renderTimer = null
  const editor = aiEditor()?.editor
  if (!editor?.setAiMarks) return
  let found: ReturnType<typeof locate> = null
  try { found = locate() } catch { return }
  const located = found?.located ?? []
  const ranges: AiMarkRange[] = located.map(l => ({ id: l.mark.id, from: l.from, to: l.to, kind: l.mark.kind, title: describe(l.mark) }))
  const bars: BlockMark[] = located.map(l => ({
    from: l.from, to: l.to,
    className: l.mark.kind === 'pin' ? 'cm-block-ai-pin' : 'cm-block-ai-highlight',
    title: describe(l.mark),
    badge: {
      label: l.mark.kind === 'pin' ? '📌' : '🖍',
      className: 'cm-block-badge-ai',
      text: `${describe(l.mark)}. Visible de vous seul, jamais écrit dans la note.`,
      actions: [{ label: l.mark.kind === 'pin' ? 'Retirer l’épingle' : 'Effacer ce surlignage', run: () => { void removeAiMark(l.mark.id) } }],
    },
  }))
  try {
    editor.setAiMarks(ranges)
    editor.setBlockMarks?.(OWNER, bars)
  } catch { /* editeur deja detruit */ }
}

function scheduleRender(): void {
  if (renderTimer) clearTimeout(renderTimer)
  renderTimer = setTimeout(render, RENDER_DELAY_MS)
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { void refreshQuotes() }, QUOTE_REFRESH_MS)
}

/** Le texte d'un passage marque a change dans la note : son ancre (memes positions) le suit. */
async function refreshQuotes(): Promise<void> {
  refreshTimer = null
  if (!aiServer()) return
  let found: ReturnType<typeof locate> = null
  try { found = locate() } catch { return }
  const path = aiEditor()?.path() ?? ''
  for (const l of found?.located ?? []) {
    const quote = l.current.slice(0, 4000)
    const moved = path !== '' && path !== l.mark.path
    if (quote === l.mark.anchor.quote && !moved) continue
    // Un surlignage vide de son texte ne dit plus rien : on garde le dernier texte connu.
    if (quote === '' && l.mark.anchor.quote !== '') continue
    const anchor: EditorAnchor = { ...l.mark.anchor, quote }
    try {
      await call('PATCH', `/${encodeURIComponent(l.mark.id)}`, { anchor, ...(moved ? { path } : {}) })
      marks = marks.map(m => m.id === l.mark.id ? { ...m, anchor, ...(moved ? { path } : {}) } : m)
    } catch (err) {
      console.warn('[aiMarks] ancre non rafraîchie', err)
    }
  }
}

/** Ce que la personne a selectionne dans la note active (ou l'endroit du curseur). */
function selection(): { vaultId: string; docId: string; path: string; anchor: EditorAnchor } | null {
  const a = aiEditor()
  const editor = a?.editor
  const docId = a?.docId()
  const vaultId = a?.vaultId()
  const session = a?.session()
  if (!a || !editor?.getSelectionRange || !docId || !vaultId || !session) return null
  const range = editor.getSelectionRange()
  const anchor = withNoteText(session, docId, text => anchorOf(text, docId, range.from, range.to))
  return anchor ? { vaultId, docId, path: a.path() ?? '', anchor } : null
}

function unavailable(): boolean {
  if (aiServer()) return false
  notify('info', 'Marques pour l’IA', 'Elles demandent un vault synchronisé par le serveur Savoire (pas un vault chiffré de bout en bout).')
  return true
}

async function add(kind: AiMark['kind'], label: string, sel: NonNullable<ReturnType<typeof selection>>): Promise<AiMark | null> {
  try {
    const mark = await call<AiMark>('POST', '', { vaultId: sel.vaultId, docId: sel.docId, kind, label, path: sel.path, anchor: sel.anchor })
    marks = [mark, ...marks]
    changed()
    return mark
  } catch (err) {
    notify('danger', kind === 'pin' ? 'Épingle non posée' : 'Passage non surligné', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Un nom par defaut : le debut du passage, sinon la section. */
function defaultPinName(anchor: EditorAnchor, path: string): string {
  const words = anchor.quote.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (words.length) return words.slice(0, 6).join(' ').slice(0, 60) + (words.length > 6 ? '…' : '')
  const note = path.split('/').pop()?.replace(/\.md$/i, '') ?? 'note'
  return `Ici, dans ${note}`
}

/** Une petite saisie par-dessus la note : le nom de l'epingle. Null : abandon. */
function askPinName(suggested: string): Promise<string | null> {
  return new Promise(resolve => {
    const coords = aiEditor()?.editor?.getSelectionCoords() ?? null
    const box = document.createElement('div')
    box.className = 'ai-pin-prompt'
    box.setAttribute('data-testid', 'ai-pin-prompt')
    const left = Math.max(12, Math.min((coords?.x ?? window.innerWidth / 2) - 150, window.innerWidth - 332))
    const top = Math.max(12, Math.min((coords?.bottom ?? coords?.y ?? window.innerHeight / 3) + 10, window.innerHeight - 110))
    box.style.left = `${left}px`
    box.style.top = `${top}px`
    const title = document.createElement('label')
    title.className = 'ai-pin-prompt-title'
    title.textContent = '📌 Épingler pour l’IA : nom de l’épingle'
    const input = document.createElement('input')
    input.type = 'text'
    input.maxLength = 200
    input.value = suggested
    input.className = 'ai-pin-prompt-input'
    input.setAttribute('data-testid', 'ai-pin-name')
    input.setAttribute('aria-label', 'Nom de l’épingle')
    const hint = document.createElement('div')
    hint.className = 'ai-pin-prompt-hint'
    hint.textContent = 'Entrée : épingler · Échap : annuler'
    box.append(title, input, hint)
    let done = false
    const finish = (value: string | null): void => {
      if (done) return
      done = true
      box.remove()
      resolve(value)
    }
    input.addEventListener('keydown', e => {
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim() || suggested) }
      if (e.key === 'Escape') { e.preventDefault(); finish(null) }
    })
    input.addEventListener('blur', () => finish(null))
    document.body.appendChild(box)
    input.focus()
    input.select()
  })
}

/** « Épingler pour l'IA » : fige la selection (ou l'endroit du curseur) sous un nom. */
export async function pinForAi(): Promise<void> {
  if (unavailable()) return
  const sel = selection()
  if (!sel) { notify('info', 'Épingler pour l’IA', 'Ouvrez une note et placez-y le curseur.'); return }
  const editor = aiEditor()?.editor
  const range = editor?.getSelectionRange?.()
  const name = await askPinName(defaultPinName(sel.anchor, sel.path))
  // La saisie a pris le focus : on rend la selection a la note.
  try { if (range && aiEditor()?.editor === editor) editor?.selectRange?.(range.from, range.to) } catch { /* editeur ferme entre-temps */ }
  if (name === null) return
  const mark = await add('pin', name, sel)
  if (mark) notify('success', 'Épinglé pour l’IA', `« ${mark.label} » : l’IA retrouvera cet endroit par son nom.`)
}

/** « Surligner pour l'IA » : marque le passage selectionne ; sur un passage deja surligne, l'efface. */
export async function highlightForAi(): Promise<void> {
  if (unavailable()) return
  const sel = selection()
  if (!sel || sel.anchor.quote === '') { notify('info', 'Surligner pour l’IA', 'Sélectionnez d’abord un passage.'); return }
  const same = marks.find(m => m.kind === 'highlight' && m.docId === sel.docId && m.anchor.start === sel.anchor.start && m.anchor.end === sel.anchor.end)
  if (same) { await removeAiMark(same.id); return }
  await add('highlight', '', sel)
}

/** Retire une marque (pastille dans la marge). */
export async function removeAiMark(id: string): Promise<void> {
  try {
    await call('DELETE', `/${encodeURIComponent(id)}`)
  } catch (err) {
    // Deja retiree ailleurs : elle part d'ici aussi.
    if (!(err instanceof Error) || !/n'existe pas|404/.test(err.message)) {
      notify('danger', 'Marque non retirée', err instanceof Error ? err.message : String(err))
      return
    }
  }
  marks = marks.filter(m => m.id !== id)
  changed()
}

/** Efface d'un coup : les marques d'un genre, dans la note active ou partout. */
export async function clearAiMarks(kind: AiMark['kind'], where: 'note' | 'all'): Promise<void> {
  if (unavailable()) return
  const docId = aiEditor()?.docId()
  if (where === 'note' && !docId) { notify('info', 'Marques pour l’IA', 'Aucune note ouverte.'); return }
  const what = kind === 'pin' ? 'épingle(s) retirée(s)' : 'surlignage(s) effacé(s)'
  try {
    const query = new URLSearchParams({ kind, ...(where === 'note' && docId ? { docId } : {}) })
    const r = await call<{ deleted: number }>('DELETE', `?${query}`)
    marks = marks.filter(m => !(m.kind === kind && (where === 'all' || m.docId === docId)))
    changed()
    notify('success', 'Marques pour l’IA', `${r.deleted} ${what}.`)
  } catch (err) {
    notify('danger', 'Marques pour l’IA', err instanceof Error ? err.message : String(err))
  }
}

/** Branche le dessin des marques sur l'editeur actif (une fois, au demarrage). */
export function startAiMarks(): void {
  onAiEditorChange(() => {
    stopEditor?.()
    stopEditor = null
    const editor = aiEditor()?.editor
    if (!editor) return
    // Le contenu arrive apres l'ouverture, puis change : les marques suivent.
    stopEditor = editor.on('documentChanged', scheduleRender)
    render()
    scheduleRender()
  })
}
