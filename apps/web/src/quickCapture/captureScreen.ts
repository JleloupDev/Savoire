// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecran de la note rapide : un champ, un bouton, rien d'autre. Il s'affiche
// avant le reste de l'appli (boot.ts) pour qu'on puisse taper tout de suite,
// pendant que l'appli se charge dessous.
//
// Il ne fait que remplir la file des notes rapides. Le plugin Agenda la vide
// dans la note du jour des qu'un vault est ouvert, et dit ou en est chaque
// note. Protocole : packages/plugins/plugin-agenda/src/quickCapture.ts (redit
// ici sans import, pour que cet ecran reste minuscule).
//
// Volontairement sans React ni CSS de l'appli : ni l'un ni l'autre n'est encore
// charge quand l'ecran s'affiche.

const QUEUE_KEY = 'savoire-quick-capture'
const OPEN_KEY = 'savoire-quick-capture-open'
const EVENT = 'savoire-quick-capture'
const DRAFT_KEY = 'savoire-quick-capture-draft'
const THEME_KEY = 'savoire-theme-v2'

interface Entry { id: string; text: string; day: string; at: number }
type CaptureEvent =
  | { type: 'queued' } | { type: 'open' } | { type: 'ready'; vault?: string }
  | { type: 'done'; id: string; path: string }
  | { type: 'error'; id: string; message: string }

const PALETTES: Record<string, Record<string, string>> = {
  light: { bg: '#f8fafc', surface: '#ffffff', border: '#e2e8f0', text: '#0f172a', muted: '#64748b', accent: '#0d9488', accentText: '#ffffff', danger: '#dc2626' },
  dark: { bg: '#1e1e2e', surface: '#181825', border: '#313244', text: '#cdd6f4', muted: '#a6adc8', accent: '#2dd4bf', accentText: '#0f172a', danger: '#f87171' },
  sepia: { bg: '#f5f0e8', surface: '#faf7f2', border: '#d6c9b5', text: '#3b2f1e', muted: '#6b5744', accent: '#0f766e', accentText: '#ffffff', danger: '#b91c1c' },
}

const CSS = `
.qc-root { position: fixed; inset: 0; z-index: 2147482000; display: flex; flex-direction: column; background: var(--qc-bg); color: var(--qc-text);
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; -webkit-tap-highlight-color: transparent;
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); box-sizing: border-box; }
.qc-root[hidden] { display: none; }
.qc-head { display: flex; align-items: center; gap: 4px; min-height: 52px; padding: 0 4px 0 16px; }
.qc-title { flex: 1; min-width: 0; margin: 0; font-size: 17px; font-weight: 600; }
.qc-day { display: block; font-size: 13px; font-weight: 400; color: var(--qc-muted); }
.qc-icon { min-width: 44px; height: 44px; border: none; border-radius: 10px; background: transparent; color: var(--qc-muted); font-size: 22px; cursor: pointer; }
.qc-body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; padding: 4px 16px 16px; }
.qc-text { flex: 1; min-height: 120px; width: 100%; box-sizing: border-box; resize: none; padding: 14px; border: 1px solid var(--qc-border); border-radius: 12px;
  background: var(--qc-surface); color: var(--qc-text); font: inherit; font-size: 17px; line-height: 1.5; outline: none; }
.qc-text:focus { border-color: var(--qc-accent); }
.qc-actions { display: flex; align-items: center; gap: 10px; }
.qc-status { flex: 1; min-width: 0; font-size: 13px; color: var(--qc-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qc-status[data-state="error"] { color: var(--qc-danger); white-space: normal; }
.qc-add { min-height: 48px; padding: 0 22px; border: none; border-radius: 12px; background: var(--qc-accent); color: var(--qc-accent-text); font: inherit; font-size: 16px; font-weight: 600; cursor: pointer; }
.qc-add:disabled { opacity: .45; cursor: default; }
.qc-open { align-self: flex-start; min-height: 44px; padding: 0 4px; border: none; background: transparent; color: var(--qc-accent); font: inherit; font-size: 15px; cursor: pointer; }
`

function today(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function readQueue(): Entry[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]')
    return Array.isArray(list) ? list as Entry[] : []
  } catch {
    return []
  }
}

/** Ajoute une note a la file. Rend son identifiant. */
export function enqueueCapture(text: string, now = new Date()): string {
  const id = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const entry: Entry = { id, text, day: today(now), at: now.getTime() }
  localStorage.setItem(QUEUE_KEY, JSON.stringify([...readQueue(), entry]))
  return id
}

function emit(detail: CaptureEvent): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail }))
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = cls
  if (text) e.textContent = text
  return e
}

export interface CaptureScreen {
  show(): void
  hide(): void
  readonly visible: boolean
}

let screen: CaptureScreen | null = null

/** L'ecran (cree au premier appel, cache). */
export function captureScreen(): CaptureScreen {
  if (screen) return screen

  const palette = PALETTES[localStorage.getItem(THEME_KEY) ?? 'light'] ?? PALETTES.light
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)

  const root = el('div', 'qc-root')
  root.hidden = true
  root.dataset.testid = 'quick-capture'
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Note rapide')
  for (const [k, v] of Object.entries(palette)) root.style.setProperty(`--qc-${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`, v)

  const head = el('div', 'qc-head')
  const title = el('h1', 'qc-title', 'Note rapide')
  const day = el('span', 'qc-day')
  title.appendChild(day)
  const close = el('button', 'qc-icon', '✕')
  close.type = 'button'
  close.title = 'Fermer'
  close.setAttribute('aria-label', 'Fermer')
  head.append(title, close)

  const body = el('div', 'qc-body')
  const text = el('textarea', 'qc-text')
  text.placeholder = 'Une idée, une chose à faire…'
  text.dataset.testid = 'quick-capture-text'
  text.setAttribute('enterkeyhint', 'done')
  text.value = localStorage.getItem(DRAFT_KEY) ?? ''
  const actions = el('div', 'qc-actions')
  const status = el('div', 'qc-status')
  status.dataset.testid = 'quick-capture-status'
  status.setAttribute('aria-live', 'polite')
  const add = el('button', 'qc-add', 'Ajouter')
  add.type = 'button'
  add.dataset.testid = 'quick-capture-add'
  actions.append(status, add)
  const openNote = el('button', 'qc-open', 'Ouvrir la note du jour')
  openNote.type = 'button'
  openNote.dataset.testid = 'quick-capture-open'
  body.append(text, actions, openNote)
  root.append(head, body)

  // ── Etat ──
  const pending = new Set<string>()
  const setStatus = (msg: string, state: 'info' | 'error' = 'info') => { status.textContent = msg; status.dataset.state = state }
  const refresh = () => {
    add.disabled = text.value.trim() === ''
    day.textContent = `Note du jour · ${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}`
  }
  const waiting = () => {
    const n = readQueue().length
    if (n === 0) return
    setStatus(n === 1 ? 'Enregistrée ici, envoi en cours…' : `${n} notes enregistrées ici, envoi en cours…`)
  }

  const submit = () => {
    const value = text.value.trim()
    if (!value) return
    const id = enqueueCapture(value)
    pending.add(id)
    text.value = ''
    localStorage.removeItem(DRAFT_KEY)
    refresh()
    waiting()
    emit({ type: 'queued' })
    text.focus()
  }

  text.addEventListener('input', () => {
    refresh()
    // Le brouillon survit a une appli fermee en pleine saisie.
    try { localStorage.setItem(DRAFT_KEY, text.value) } catch { /* plein */ }
  })
  text.addEventListener('keydown', e => {
    // Ctrl+Entree (clavier physique) : ajouter. Entree seule fait une ligne.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
    if (e.key === 'Escape') { e.preventDefault(); api.hide() }
  })
  add.addEventListener('click', submit)
  openNote.addEventListener('click', () => {
    if (text.value.trim()) submit()
    localStorage.setItem(OPEN_KEY, '1')
    emit({ type: 'open' })
    api.hide()
  })
  close.addEventListener('click', () => api.hide())

  window.addEventListener(EVENT, e => {
    const d = (e as CustomEvent<CaptureEvent>).detail
    if (d.type === 'done') {
      pending.delete(d.id)
      if (readQueue().length === 0) setStatus(`Ajoutée à ${d.path}`)
      else waiting()
    } else if (d.type === 'error') {
      setStatus(`Pas encore envoyée : ${d.message} Elle reste ici et repartira toute seule.`, 'error')
    }
  })

  // ── Retour du telephone : ferme l'ecran, sans faire reculer l'appli ──
  // L'ecran pose une entree d'historique. Notre ecouteur passe avant celui
  // de l'appli (inscrit plus tot, en capture) et l'arrete quand il s'agit de
  // nous ; sinon la coquille mobile reculerait d'un ecran.
  let ownEntry = false
  let skipPop = false
  window.addEventListener('popstate', e => {
    if (skipPop) { skipPop = false; e.stopImmediatePropagation(); return }
    if (ownEntry && !root.hidden) {
      ownEntry = false
      e.stopImmediatePropagation()
      hideNow()
    }
  }, true)

  const hideNow = () => {
    root.hidden = true
    text.blur()
  }

  const api: CaptureScreen = {
    show() {
      refresh()
      if (pending.size === 0) { setStatus(''); waiting() }
      if (root.hidden) {
        root.hidden = false
        if (!ownEntry) { history.pushState({ ...(history.state as object | null), savoireCapture: true }, ''); ownEntry = true }
      }
      // Le clavier s'ouvre tout de suite (Android : le champ a le focus des l'affichage).
      text.focus()
      requestAnimationFrame(() => text.focus())
    },
    hide() {
      if (root.hidden) return
      hideNow()
      if (ownEntry) { ownEntry = false; skipPop = true; history.back() }
    },
    get visible() { return !root.hidden },
  }

  ;(document.body ?? document.documentElement).appendChild(root)
  screen = api
  return api
}
