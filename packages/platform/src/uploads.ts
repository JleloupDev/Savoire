// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Suivi des envois de pieces jointes. Le vault annonce chaque envoi (debut,
// progression, fin ou echec) ; l'application en fait des notifications. La
// plateforme ne sait rien de l'affichage : elle ne fait que publier.

export type UploadEvent =
  /** `fraction` : 0..1, ou null si la progression n'est pas mesurable (pair a pair). */
  | { kind: 'progress'; uploadId: number; fileName: string; fraction: number | null }
  | { kind: 'done'; uploadId: number; fileName: string; path: string }
  | { kind: 'error'; uploadId: number; fileName: string; reason: string }

/** Le suivi d'un envoi en cours. */
export interface UploadReport {
  progress(fraction: number): void
  done(path: string): void
  fail(error: unknown): void
}

/** Raison lisible d'un echec d'envoi. */
export function uploadErrorReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (/^413\b/.test(raw)) return 'fichier trop lourd'
  if (/^400\b/.test(raw)) return 'fichier refusé par le serveur (type non accepté ou plus de 20 Mo)'
  if (/^(401|403|404)\b/.test(raw)) return 'droit d\'écriture refusé sur ce vault'
  if (/^5\d\d\b/.test(raw)) return 'erreur du serveur'
  if (/network|failed to fetch/i.test(raw)) return 'connexion perdue'
  return raw || 'erreur inconnue'
}

type Listener = (event: UploadEvent) => void

export class UploadTracker {
  private nextId = 0
  private readonly listeners = new Set<Listener>()

  subscribe(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** Commence le suivi d'un envoi : il est annonce « en cours », sans progression connue. */
  begin(fileName: string): UploadReport {
    const uploadId = ++this.nextId
    let finished = false
    this.emit({ kind: 'progress', uploadId, fileName, fraction: null })
    return {
      progress: fraction => {
        if (finished) return
        this.emit({ kind: 'progress', uploadId, fileName, fraction: Math.max(0, Math.min(1, fraction)) })
      },
      done: path => {
        if (finished) return
        finished = true
        this.emit({ kind: 'done', uploadId, fileName, path })
      },
      fail: error => {
        if (finished) return
        finished = true
        this.emit({ kind: 'error', uploadId, fileName, reason: uploadErrorReason(error) })
      },
    }
  }

  private emit(event: UploadEvent): void {
    for (const cb of this.listeners) {
      try { cb(event) } catch (err) { console.error('[uploads] abonne en erreur', err) }
    }
  }
}

/** Suivi commun a tous les vaults de l'application. */
export const uploadTracker = new UploadTracker()

export function subscribeUploads(cb: Listener): () => void {
  return uploadTracker.subscribe(cb)
}
