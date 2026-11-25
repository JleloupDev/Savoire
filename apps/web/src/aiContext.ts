// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le contexte de l'editeur, pour l'IA : la note ouverte, la selection (ou le
// curseur), la section. Quand la personne dit a ChatGPT ou a Claude
// « reformule ce passage », l'IA le lit par l'outil get_context.
//
//  - A chaque selection ou deplacement du curseur (apres une courte pause),
//    une entree est construite (agent-core/editorContext.ts) et gardee ici :
//    l'assistant de l'appli la lit sans passer par le serveur.
//  - En profil serveur seulement, elle est aussi envoyee au serveur, qui la
//    garde en memoire pour les IA externes. Jamais pour un vault chiffre de
//    bout en bout : le texte selectionne passerait en clair.
//  - Quand l'editeur perd le focus, on ne touche a rien : la personne est
//    partie dans la fenetre de ChatGPT, la derniere entree reste la bonne.
//  - Plusieurs onglets ou appareils : le dernier actif l'emporte (revenir sur
//    la fenetre renvoie l'entree).
//  - Quand la personne tape, l'entree porte l'heure de sa derniere frappe
//    (typingAt) : un agent n'ecrit pas dans ce paragraphe tant que c'est
//    recent. Une frappe ne declenche rien d'autre : elle note l'heure, et
//    l'entree part au plus une fois toutes les 2 s (la premiere tout de suite).
import {
  EditorContextRing, TYPING_GUARD_MS, buildAnchor, buildEditorContext, locateByQuote, sameEditorContext,
  type EditorAnchor, type EditorContextEntry, type TypingSpot,
} from '@savoire/agent-core'
import type { IVaultSyncSession } from '@savoire/application'
import type { ICollaborativeText } from '@savoire/domain-index'
import type { EditorController } from '@savoire/editor-core'
import { decodeRelPos, encodeRelPos } from '@savoire/infrastructure-sync'
import type { ICRDT } from '@savoire/plugin-api'

export interface AiEditor {
  editor: EditorController | null
  docId(): string | undefined
  path(): string | undefined
  vaultId(): string | undefined
  session(): IVaultSyncSession | undefined
}

/** Le serveur Savoire, en profil serveur (null ailleurs : rien n'est envoye). */
export interface AiServer {
  token(): string
  url(path: string): string
}

/** Pause apres la derniere selection avant de la retenir. */
const CAPTURE_DELAY_MS = 300
/** Au plus un envoi par seconde. */
const SEND_INTERVAL_MS = 1000
/** Pendant la frappe : au plus une entree toutes les 2 s. */
const TYPING_REPORT_MS = 2000

let server: AiServer | null = null
let active: AiEditor | null = null
let stopListening: (() => void) | null = null
let captureTimer: ReturnType<typeof setTimeout> | null = null
let sendTimer: ReturnType<typeof setTimeout> | null = null
let lastSendAt = 0
let lastSent: EditorContextEntry | null = null
/** Heure de la derniere frappe ; `typingDirty` : pas encore dans une entree. */
let typedAt = 0
let typingDirty = false
let typingTimer: ReturnType<typeof setTimeout> | null = null
let lastTypingCapture = 0
/** Vaults ou le serveur refuse le contexte (chiffres de bout en bout) : on n'insiste pas. */
const refused = new Set<string>()
const ring = new EditorContextRing()
const editorListeners = new Set<() => void>()

// Etat de toute la session (editeur actif, abonnements) : un remplacement a
// chaud (Vite) en ferait un second exemplaire, jamais branche.
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload() })

function tabId(): string {
  const KEY = 'savoire.ai-tab'
  try {
    let id = sessionStorage.getItem(KEY)
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem(KEY, id) }
    return id
  } catch {
    return 'onglet'
  }
}

/** Le texte collaboratif d'une note (celui de l'editeur), le temps de `use`. Null : pas un texte. */
export function withNoteText<T>(session: IVaultSyncSession, docId: string, use: (text: ICollaborativeText) => T): T | null {
  const crdt = session.openDocument(docId) as ICRDT
  try {
    const collab = crdt.collaborativeText?.()
    return collab ? use(collab) : null
  } finally {
    session.closeDocument(docId)
  }
}

/** L'ancre du passage [from, to) de la note. */
export function anchorOf(text: ICollaborativeText, docId: string, from: number, to: number): EditorAnchor {
  return buildAnchor({ docId, text: text.toString(), from, to, encode: (i, assoc) => encodeRelPos(text.createRelPos(i, assoc)) })
}

/**
 * Ou est le passage d'une ancre aujourd'hui : par ses positions relatives,
 * sinon par son texte. Null : il a disparu.
 */
export function locateAnchor(text: ICollaborativeText, anchor: EditorAnchor): { from: number; to: number } | null {
  const start = decodeRelPos(anchor.start)
  const end = anchor.end === anchor.start ? start : decodeRelPos(anchor.end)
  const from = start ? text.resolveRelPos(start) : null
  const to = end ? text.resolveRelPos(end) : null
  if (from !== null && to !== null && to >= from && (to > from || anchor.quote === '')) return { from, to }
  return locateByQuote(text.toString(), anchor)
}

function capture(force = false): void {
  captureTimer = null
  const a = active
  const editor = a?.editor
  const docId = a?.docId()
  const vaultId = a?.vaultId()
  const session = a?.session()
  if (!a || !editor?.getSelectionRange || !docId || !vaultId || !session) return
  let entry: EditorContextEntry | null
  // Elle a tape depuis la derniere entree : celle-ci le dit.
  const typingAt = typingDirty ? typedAt : 0
  try {
    const range = editor.getSelectionRange()
    entry = withNoteText(session, docId, text => buildEditorContext({
      vaultId, docId, path: a.path() ?? '', text: text.toString(), from: range.from, to: range.to,
      tabId: tabId(), at: Date.now(), encode: (i, assoc) => encodeRelPos(text.createRelPos(i, assoc)),
      ...(typingAt ? { typingAt } : {}),
    }))
  } catch {
    // Editeur deja detruit, note pas encore chargee : la derniere entree reste.
    return
  }
  if (!entry) return
  if (typingAt) {
    typingDirty = false
    lastTypingCapture = Date.now()
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null }
  }
  if (!force && !typingAt && sameEditorContext(entry, ring.last())) return
  ring.push(entry)
  queueSend()
}

/**
 * La personne vient de taper : on note l'heure, rien de plus. L'entree qui le
 * dit part tout de suite si la derniere a plus de 2 s, sinon a cette echeance.
 */
function typed(): void {
  typedAt = Date.now()
  typingDirty = true
  if (typingTimer) return
  // Un tour de boucle au moins : le texte partage a recu la frappe (memes positions que l'editeur).
  typingTimer = setTimeout(() => {
    typingTimer = null
    if (captureTimer) clearTimeout(captureTimer)
    capture()
  }, Math.max(0, lastTypingCapture + TYPING_REPORT_MS - typedAt))
}

function schedule(): void {
  if (captureTimer) clearTimeout(captureTimer)
  captureTimer = setTimeout(capture, CAPTURE_DELAY_MS)
}

function queueSend(): void {
  if (!server || sendTimer) return
  sendTimer = setTimeout(() => { void send() }, Math.max(0, lastSendAt + SEND_INTERVAL_MS - Date.now()))
}

async function send(): Promise<void> {
  sendTimer = null
  const entry = ring.last()
  const s = server
  if (!entry || !s || entry === lastSent || refused.has(entry.vaultId)) return
  const token = s.token()
  if (!token) return
  lastSent = entry
  lastSendAt = Date.now()
  try {
    const res = await fetch(s.url('/api/v1/me/editor-context'), {
      method: 'POST', keepalive: true,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
    if (res.status === 403) refused.add(entry.vaultId)
  } catch {
    // Hors ligne : le prochain deplacement renverra.
  }
}

if (typeof window !== 'undefined') {
  // Retour sur cette fenetre : c'est de nouveau ici que la personne travaille.
  window.addEventListener('focus', () => capture(true))
}

/** Le serveur a qui envoyer le contexte (profil serveur), ou null (autres profils, deconnexion). */
export function setAiServer(s: AiServer | null): void {
  server = s
  if (!s) { lastSent = null; refused.clear() }
}

export function aiServer(): AiServer | null {
  return server
}

/** L'editeur de notes actif (appele a chaque changement d'editeur). */
export function setAiEditor(editor: AiEditor): void {
  stopListening?.()
  stopListening = null
  active = editor
  if (editor.editor) {
    // Fermer la note ne vide rien : la derniere entree reste la bonne.
    const stopSelection = editor.editor.on('selectionChanged', schedule)
    const stopTyping = editor.editor.on('userTyped', typed)
    stopListening = () => { stopSelection(); stopTyping() }
    schedule()
  }
  for (const cb of [...editorListeners]) cb()
}

export function aiEditor(): AiEditor | null {
  return active
}

/** L'editeur actif a change. */
export function onAiEditorChange(cb: () => void): () => void {
  editorListeners.add(cb)
  return () => { editorListeners.delete(cb) }
}

/**
 * Ou la personne tape en ce moment dans cette note (les agents de l'appli,
 * la veille) : la derniere entree ou elle tapait, si c'est recent. Null : elle
 * n'y tape pas.
 */
export function typingSpot(docId: string, now = Date.now()): TypingSpot | null {
  // Une frappe pas encore retenue compte tout de suite.
  if (typingDirty) capture()
  const e = ring.lastTyped()
  if (!e?.typingAt || e.docId !== docId) return null
  const ageMs = Math.max(0, now - e.typingAt)
  if (ageMs >= TYPING_GUARD_MS) return null
  return { docId, ageMs, blockHash: e.blockHash, anchor: { start: e.anchor.start, end: e.anchor.end, prefix: e.anchor.prefix, suffix: e.anchor.suffix } }
}

/** Ou etait la personne il y a `secondsAgo` secondes (l'assistant de l'appli). */
export function editorContextAt(secondsAgo: number): { entry: EditorContextEntry; ageSeconds: number } | null {
  // Ce qui vient d'etre selectionne compte tout de suite, sans attendre la pause.
  if (captureTimer) { clearTimeout(captureTimer); capture() }
  return ring.at(secondsAgo, Date.now())
}
