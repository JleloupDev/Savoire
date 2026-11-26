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
// Sans code QR : tant que la presentation attend un telephone, l'ordinateur
// la propose aux autres appareils du compte (SlideOffer, toutes les 5 s, par
// le serveur qui relaie sans rien garder). Un telephone ou Savoire est
// ouvert affiche « Devenir la télécommande ? » ; oui, il ouvre l'adresse de
// la telecommande, comme s'il avait scanne le code.
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
  /**
   * Propose la presentation aux autres appareils du compte, jusqu'a ce qu'un
   * telephone se connecte (repris s'il se deconnecte). Absent : pas de
   * proposition (le code QR reste).
   */
  offer?(title: string): void
  close(): void
}

/** Une presentation proposee aux autres appareils du compte. */
export interface SlideOffer {
  kind: 'slides-offer'
  vaultId: string
  docId: string
  session: string
  title: string
  /** La proposition est retiree (telephone connecte, presentation finie). */
  ended?: boolean
}

/** Une proposition est renvoyee a ce rythme tant qu'elle tient. */
export const SLIDE_OFFER_EVERY_MS = 5000
/** Sans nouvelle depuis ce delai, le telephone oublie la proposition. */
export const SLIDE_OFFER_TTL_MS = 16000

export function isSlideOffer(m: unknown): m is SlideOffer {
  if (!m || typeof m !== 'object') return false
  const o = m as Record<string, unknown>
  return o.kind === 'slides-offer' && typeof o.vaultId === 'string' && typeof o.docId === 'string'
    && typeof o.session === 'string' && typeof o.title === 'string'
}

/** Adresse relative de la telecommande, dans la meme appli (telephone qui accepte). */
export function remotePath(vaultId: string, docId: string, session: string): string {
  return `/?${new URLSearchParams({ window: 'remote', vault: vaultId, note: docId, session }).toString()}`
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
