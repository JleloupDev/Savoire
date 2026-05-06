// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export type ToastType = 'success' | 'info' | 'warn' | 'danger'

export interface Toast {
  id: number
  type: ToastType
  title: string
  message?: string
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
