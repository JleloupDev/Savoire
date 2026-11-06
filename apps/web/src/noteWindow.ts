// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Une note dans sa propre fenetre (appli web) :
//
//  - « Nouvelle fenetre » : une fenetre du navigateur qui ne montre que cette
//    note (sans rail ni panneaux), pour la garder a cote du reste. C'est
//    l'appli entiere, sur une adresse `/?window=note&vault=...&note=...` :
//    elle a sa propre synchro, les modifications se voient dans les deux.
//    La session suit : une fenetre ouverte par la page recoit une copie de
//    son sessionStorage, mais elle ne renouvelle jamais la session : elle
//    prend le jeton de la fenetre qui l'a ouverte (authBridge.ts).
//
//  - « Epingler » : la note toujours au premier plan, au-dessus des autres
//    fenetres. Le navigateur ne sait le faire qu'avec une fenetre
//    d'incrustation (Document Picture-in-Picture : Chrome et Edge 116+).
//    On y met la meme adresse dans un cadre. Ailleurs (Firefox, Safari,
//    le bouton n'apparait pas. La fenetre epinglee se ferme avec la fenetre
//    qui l'a ouverte.
//
//  - Appli de bureau (Tauri) : une vraie fenetre de l'application
//    (src-tauri/src/note_window.rs), qui sait rester au premier plan. La
//    note lui est donnee par window.__SAVOIRE_NOTE_WINDOW__ ; la session
//    vient de la fenetre principale par evenements (authBridge.ts).

import { HOST_KEY } from './authBridge'
import { isAndroidRuntime, isTauriRuntime } from './tauriRuntime'

/** Fenetre de bureau : la note posee par son script d'initialisation. */
interface DesktopNoteTarget { vaultId?: unknown; path?: unknown; pinned?: unknown }

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke(cmd: string, args?: unknown): Promise<T> } }).__TAURI_INTERNALS__
  if (!internals) return Promise.reject(new Error('Coquille bureau absente.'))
  return internals.invoke(cmd, args)
}

/** Appli de bureau (pas Android) : fenetres natives. */
export function desktopWindows(): boolean {
  return isTauriRuntime() && !isAndroidRuntime()
}

export interface NoteWindowTarget {
  vaultId: string
  path: string
  /** Affichee dans une fenetre epinglee. */
  pinned: boolean
}

/** La note a montrer seule, d'apres l'adresse de la page ; null : appli normale. */
export function readNoteWindow(search: string = typeof window !== 'undefined' ? window.location.search : ''): NoteWindowTarget | null {
  const desktop = typeof window !== 'undefined'
    ? (window as unknown as { __SAVOIRE_NOTE_WINDOW__?: DesktopNoteTarget }).__SAVOIRE_NOTE_WINDOW__
    : undefined
  if (desktop && typeof desktop.vaultId === 'string' && typeof desktop.path === 'string') {
    return { vaultId: desktop.vaultId, path: desktop.path, pinned: desktop.pinned === true }
  }
  const q = new URLSearchParams(search)
  if (q.get('window') !== 'note') return null
  const vaultId = q.get('vault')
  const path = q.get('note')
  if (!vaultId || !path) return null
  return { vaultId, path, pinned: q.get('pinned') === '1' }
}

export function noteWindowUrl(vaultId: string, path: string, pinned = false, origin = window.location.origin): string {
  const q = new URLSearchParams({ window: 'note', vault: vaultId, note: path })
  if (pinned) q.set('pinned', '1')
  return `${origin}/?${q.toString()}`
}

/** Nom affiche d'une note (titre de la fenetre). */
export function noteTitle(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '')
}

/** Ouvre la note dans une nouvelle fenetre (navigateur ou bureau). Faux si le navigateur l'a bloquee. */
export function openNoteWindow(vaultId: string, path: string): boolean {
  if (desktopWindows()) {
    void tauriInvoke('note_window_open', { vaultId, path, pinned: false })
      .catch(err => console.error('[fenetre de note]', err))
    return true
  }
  // Pas de noopener : la nouvelle fenetre doit recevoir la session.
  const w = window.open(noteWindowUrl(vaultId, path), `savoire-note-${vaultId}-${path}`, 'popup,width=760,height=900')
  return !!w
}

interface PipWindowApi {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>
  window: Window | null
}

function pipApi(): PipWindowApi | null {
  const api = (window as unknown as { documentPictureInPicture?: PipWindowApi }).documentPictureInPicture
  return api && typeof api.requestWindow === 'function' ? api : null
}

/** Le navigateur sait garder une fenetre au premier plan. */
export function canPinNote(): boolean {
  return typeof window !== 'undefined' && (desktopWindows() || pipApi() !== null)
}

/**
 * Bureau : epingle (ou non) la fenetre de note courante. Rend vrai si fait.
 * Dans la fenetre principale : faux (on ouvre plutot une fenetre epinglee).
 */
export async function setDesktopPinned(pinned: boolean): Promise<boolean> {
  if (!desktopWindows() || !readNoteWindow()) return false
  await tauriInvoke('note_window_pin', { pinned })
  return true
}

/**
 * Epingle la note : une fenetre toujours au premier plan qui la montre.
 * Doit suivre un geste de la personne (clic). Une seule a la fois : une
 * nouvelle demande remplace la precedente.
 */
export async function pinNote(vaultId: string, path: string, size = { width: 520, height: 700 }): Promise<void> {
  if (desktopWindows()) {
    await tauriInvoke('note_window_open', { vaultId, path, pinned: true })
    return
  }
  const api = pipApi()
  if (!api) throw new Error('Ce navigateur ne sait pas garder une fenêtre au premier plan.')
  const pip = await api.requestWindow(size)
  // La note epinglee prend la session de cette fenetre (authBridge.ts).
  ;(pip as unknown as Record<string, unknown>)[HOST_KEY] = window
  const doc = pip.document
  doc.title = `📌 ${noteTitle(path)}`
  const style = doc.createElement('style')
  style.textContent = 'html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}'
  doc.head.appendChild(style)
  const frame = doc.createElement('iframe')
  frame.title = noteTitle(path)
  frame.src = noteWindowUrl(vaultId, path, true)
  doc.body.appendChild(frame)
}
