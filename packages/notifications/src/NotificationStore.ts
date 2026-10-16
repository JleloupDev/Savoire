// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export type ToastType = 'success' | 'info' | 'warn' | 'danger'

export interface Toast {
  id: number
  type: ToastType
  title: string
  message?: string
  /**
   * Notification « en cours » (un envoi...) : elle reste affichee tant
   * qu'elle n'est pas terminee par succeed() ou fail().
   */
  pending?: boolean
  /** Progression 0..1 d'une notification en cours ; null : en cours, sans mesure. */
  progress?: number | null
}

/** Une notification en cours, a faire avancer puis terminer. */
export interface ProgressToast {
  readonly id: number
  /** Nouvelle progression (0..1, ou null si inconnue), et eventuellement un nouveau message. */
  update(progress: number | null, message?: string): void
  /** Termine en succes : la notification devient ordinaire et s'efface seule. */
  succeed(title: string, message?: string): void
  /** Termine en echec. Si la personne l'avait fermee, l'echec reapparait quand meme. */
  fail(title: string, message?: string): void
}

type Subscriber = (toasts: Toast[]) => void

let nextId = 0
let toasts: Toast[] = []
const subscribers = new Set<Subscriber>()

function emit() {
  for (const cb of subscribers) cb(toasts)
}

export function notify(type: ToastType, title: string, message?: string): void {
  const id = ++nextId
  toasts = [...toasts, { id, type, title, message }]
  emit()
}

export function dismiss(id: number): void {
  toasts = toasts.filter(t => t.id !== id)
  emit()
}

export function subscribeToasts(cb: Subscriber): () => void {
  subscribers.add(cb)
  cb(toasts)
  return () => subscribers.delete(cb)
}

function patch(id: number, change: Partial<Toast>): boolean {
  if (!toasts.some(t => t.id === id)) return false
  toasts = toasts.map(t => (t.id === id ? { ...t, ...change } : t))
  emit()
  return true
}

/**
 * Notification « en cours » avec barre de progression (envoi d'un fichier...).
 * Elle ne s'efface pas seule : on la termine par succeed() ou fail(), qui la
 * changent sur place en notification de succes ou d'erreur.
 */
export function notifyProgress(title: string, message?: string): ProgressToast {
  const id = ++nextId
  let done = false
  toasts = [...toasts, { id, type: 'info', title, message, pending: true, progress: null }]
  emit()
  return {
    id,
    update(progress, nextMessage) {
      if (done) return
      const value = progress === null ? null : Math.max(0, Math.min(1, progress))
      patch(id, nextMessage === undefined ? { progress: value } : { progress: value, message: nextMessage })
    },
    succeed(nextTitle, nextMessage) {
      if (done) return
      done = true
      patch(id, { type: 'success', title: nextTitle, message: nextMessage, pending: false, progress: undefined })
    },
    fail(nextTitle, nextMessage) {
      if (done) return
      done = true
      if (!patch(id, { type: 'danger', title: nextTitle, message: nextMessage, pending: false, progress: undefined })) {
        notify('danger', nextTitle, nextMessage)
      }
    },
  }
}
