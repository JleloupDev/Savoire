// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Telecommande d'une presentation : le telephone fait defiler les
// diapositives et montre les notes du presentateur ; l'ordinateur montre les
// diapositives.
//
// L'ordinateur affiche un code QR : l'adresse de l'appli avec
// `?window=remote&vault=...&note=...&session=...`. Le telephone, connecte au
// meme compte, l'ouvre ; les deux se parlent par des messages ephemeres sur
// la room de la note (presence du hub, rien n'est garde). Seul qui a acces a
// la note y entre ; la session (aleatoire, dans le code) separe deux
// presentations de la meme note.
//
// Ce module ne connait que le protocole (partage par l'editeur et l'appli).
// Le transport vient de l'appli (editor-core/SlideRemote.ts,
// setSlideRemoteFactory) : l'editeur ne sait rien des vaults ni du hub.

/** Ce que l'ordinateur annonce : la diapositive montree, ses notes. */
export interface SlideScreenState {
  role: 'screen'
  session: string
  /** Rang (0...) et nombre de diapositives. */
  index: number
  count: number
  /** Etape montree et nombre d'etapes (apparitions au clic). */
  step: number
  steps: number
  title: string
  notes: string
  nextTitle: string
  /** La presentation est finie (l'ordinateur l'a fermee). */
  ended?: boolean
}

export type SlideRemoteCommand = 'hello' | 'next' | 'previous' | 'goto' | 'bye'

/** Ce que le telephone demande. `seq` croit : un ordre n'est applique qu'une fois. */
export interface SlideRemoteOrder {
  role: 'remote'
  session: string
  seq: number
  cmd: SlideRemoteCommand
  /** Pour goto : rang de la diapositive. */
  index?: number
}

export type SlideRemoteMessage = SlideScreenState | SlideRemoteOrder

/** Un lien ouvert entre l'ordinateur et le telephone. */
export interface SlideRemoteLink {
  /** L'adresse a ouvrir sur le telephone (dans le code QR). */
  readonly url: string
  /** Adresse locale (localhost) : un telephone ne la joindra pas. */
  readonly local: boolean
  send(message: SlideRemoteMessage): void
  onMessage(cb: (message: SlideRemoteMessage) => void): () => void
  close(): void
}

/** Une session de telecommande : 16 octets aleatoires, en base64url. */
export function newRemoteSession(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Taille max des notes envoyees au telephone. */
export const REMOTE_NOTES_MAX = 6000

/** Le message est-il de ce protocole, pour cette session ? */
export function isRemoteMessage(m: unknown, session: string): m is SlideRemoteMessage {
  if (!m || typeof m !== 'object') return false
  const o = m as Record<string, unknown>
  return o.session === session && (o.role === 'screen' || o.role === 'remote')
}

/** Adresse de la telecommande. */
export function remoteUrl(origin: string, vaultId: string, docId: string, session: string): string {
  const q = new URLSearchParams({ window: 'remote', vault: vaultId, note: docId, session })
  return `${origin.replace(/\/+$/, '')}/?${q.toString()}`
}

/** Une adresse que seul cet ordinateur joint. */
export function isLocalOrigin(origin: string): boolean {
  try {
    const h = new URL(origin).hostname
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || h.endsWith('.localhost')
  } catch {
    return true
  }
}
