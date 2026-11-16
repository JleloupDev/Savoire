// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Retours des testeurs (voir FeedbackBubble.tsx, FeedbackAdmin.tsx).
//  - envoi : POST /api/v1/feedback, tout compte connecte ;
//  - lecture, rangement, suppression : /api/v1/admin/feedback, administrateur.
//
// La capture montre l'ecran tel quel, notes comprises : la personne la voit
// avant l'envoi et peut la retirer.
import { fetchWithRenewal, serverUrl } from '@savoire/infrastructure-sync'
import { isAndroidRuntime, isTauriRuntime } from './tauriRuntime'

/** Les elements marques ainsi ne sont pas dans la capture (la bulle elle-meme). */
export const FEEDBACK_IGNORE_ATTR = 'data-feedback-ignore'

const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024

export interface FeedbackReport {
  id: string
  userId: string
  userName: string | null
  userEmail: string | null
  message: string
  /** Contexte releve a l'envoi (JSON, voir collectFeedbackContext). */
  context: string
  userAgent: string | null
  hasScreenshot: boolean
  createdAt: string
  archivedAt: string | null
}

// ── Contexte ────────────────────────────────────────────────────────────────

// Dernieres erreurs de la page (message seul) : utiles pour comprendre un retour.
const recentErrors: string[] = []
if (typeof window !== 'undefined') {
  const keep = (msg: unknown) => {
    const text = String(msg ?? '').slice(0, 200)
    if (!text) return
    recentErrors.push(text)
    if (recentErrors.length > 5) recentErrors.shift()
  }
  window.addEventListener('error', e => keep(e.message))
  window.addEventListener('unhandledrejection', e => keep((e.reason as { message?: unknown } | undefined)?.message ?? e.reason))
}

/** Ce que l'appli sait de l'ecran au moment du retour. Pas d'adresse complete (jetons possibles). */
export function collectFeedbackContext(): Record<string, unknown> {
  return {
    path: location.pathname,
    title: document.title,
    platform: isAndroidRuntime() ? 'android' : isTauriRuntime() ? 'desktop' : 'web',
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    screen: `${screen.width}x${screen.height}`,
    pixelRatio: window.devicePixelRatio,
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    online: navigator.onLine,
    theme: document.documentElement.dataset.theme ?? null,
    server: serverUrl('/'),
    recentErrors: [...recentErrors],
  }
}

// ── Capture ─────────────────────────────────────────────────────────────────

/**
 * Capture de la page, en JPEG (data URL). null : la capture a echoue (on
 * envoie sans). Les cadres d'autres origines (boards) restent vides.
 */
export async function captureScreen(): Promise<string | null> {
  try {
    const { toJpeg } = await import('html-to-image')
    const filter = (node: HTMLElement) => !(node instanceof Element && node.hasAttribute(FEEDBACK_IGNORE_ATTR))
    for (const [pixelRatio, quality] of [[Math.min(window.devicePixelRatio || 1, 1.5), 0.8], [1, 0.6]] as const) {
      const url = await toJpeg(document.body, { pixelRatio, quality, filter, backgroundColor: getComputedStyle(document.body).backgroundColor })
      // base64 : 4 caracteres pour 3 octets.
      if (url.length * 0.75 <= MAX_SCREENSHOT_BYTES) return url
    }
    return null
  } catch (err) {
    console.warn('[feedback] capture impossible', err)
    return null
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

async function call(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetchWithRenewal(globalThis.fetch.bind(globalThis), serverUrl(path), {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  })
  if (!res.ok) {
    const problem = await res.json().catch(() => null) as { detail?: string; errors?: Record<string, string[]>; title?: string } | null
    const first = problem?.errors ? Object.values(problem.errors).flat()[0] : undefined
    throw new Error(first ?? problem?.detail ?? problem?.title ?? `Erreur ${res.status}`)
  }
  return res
}

export async function submitFeedback(token: string, input: { message: string; context: Record<string, unknown>; screenshot: string | null }): Promise<void> {
  await call(token, '/api/v1/feedback', { method: 'POST', body: JSON.stringify(input) })
}

export const feedbackAdminApi = {
  async list(token: string, archived = false): Promise<FeedbackReport[]> {
    return (await call(token, `/api/v1/admin/feedback?archived=${archived}`)).json() as Promise<FeedbackReport[]>
  },
  /** La capture, en adresse locale (URL.createObjectURL) : a liberer avec URL.revokeObjectURL. */
  async screenshotUrl(token: string, id: string): Promise<string> {
    const blob = await (await call(token, `/api/v1/admin/feedback/${encodeURIComponent(id)}/screenshot`)).blob()
    return URL.createObjectURL(blob)
  },
  async setArchived(token: string, id: string, archived: boolean): Promise<void> {
    await call(token, `/api/v1/admin/feedback/${encodeURIComponent(id)}/archive`, { method: 'POST', body: JSON.stringify({ archived }) })
  },
  async remove(token: string, id: string): Promise<void> {
    await call(token, `/api/v1/admin/feedback/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },
}
