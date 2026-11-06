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
//    appli de bureau), le bouton n'apparait pas. La fenetre epinglee se
//    ferme avec la fenetre qui l'a ouverte.

import { HOST_KEY } from './authBridge'

export interface NoteWindowTarget {
  vaultId: string
  path: string
  /** Affichee dans une fenetre epinglee. */
  pinned: boolean
}

/** La note a montrer seule, d'apres l'adresse de la page ; null : appli normale. */
export function readNoteWindow(search: string = typeof window !== 'undefined' ? window.location.search : ''): NoteWindowTarget | null {
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

/** Ouvre la note dans une nouvelle fenetre du navigateur. Faux si le navigateur l'a bloquee. */
export function openNoteWindow(vaultId: string, path: string): boolean {
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
  return typeof window !== 'undefined' && pipApi() !== null
}

/**
 * Epingle la note : une fenetre toujours au premier plan qui la montre.
 * Doit suivre un geste de la personne (clic). Une seule a la fois : une
 * nouvelle demande remplace la precedente.
 */
export async function pinNote(vaultId: string, path: string, size = { width: 520, height: 700 }): Promise<void> {
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
