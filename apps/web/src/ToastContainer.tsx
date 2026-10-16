// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect } from 'react'
import { subscribeToasts, dismiss } from '@savoire/notifications'
import type { Toast, ToastType } from '@savoire/notifications'
import { showUploadsAsToasts } from './uploadToasts'

const DURATION = 4000
/** Une erreur reste plus longtemps : on doit avoir le temps de lire la raison. */
const ERROR_DURATION = 8000

const ICONS: Record<ToastType, React.ReactNode> = {
  success: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>,
  info:    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>,
  warn:    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  danger:  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>,
}

const COLORS: Record<ToastType, string> = {
  success: 'var(--color-success)',
  info:    'var(--color-info)',
  warn:    'var(--color-warn)',
  danger:  'var(--color-danger)',
}

function ToastItem({ toast }: { toast: Toast }) {
  const [visible, setVisible] = useState(false)
  const [progress, setProgress] = useState(100)
  const color = COLORS[toast.type]
  const pending = !!toast.pending

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
  }, [toast.id])

  // Compte a rebours de fermeture. Une notification en cours (envoi) n'en a
  // pas : il demarre quand elle se termine (succes ou erreur).
  useEffect(() => {
    if (pending) return
    const duration = toast.type === 'danger' ? ERROR_DURATION : DURATION
    const start = Date.now()
    const tick = setInterval(() => {
      const elapsed = Date.now() - start
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100)
      setProgress(remaining)
      if (remaining === 0) {
        clearInterval(tick)
        setTimeout(() => dismiss(toast.id), 300)
      }
    }, 50)
    return () => clearInterval(tick)
  }, [toast.id, pending, toast.type])

  return (
    <div data-testid="toast" data-toast-type={toast.type} data-pending={String(pending)} style={{
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderLeft: `3px solid ${color}`,
      borderRadius: 'var(--radius-xl)',
      boxShadow: 'var(--shadow-lg)',
      width: 320,
      overflow: 'hidden',
      transform: visible ? 'translateX(0)' : 'translateX(32px)',
      opacity: visible ? 1 : 0,
      transition: 'transform 0.22s ease, opacity 0.22s ease',
    }}>
      <div style={{ padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <span style={{ color, flexShrink: 0, marginTop: 1, display: 'flex' }}>{ICONS[toast.type]}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: toast.message ? 2 : 0 }}>
            {toast.title}
          </div>
          {toast.message && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{toast.message}</div>
          )}
        </div>
        <button
          onClick={() => dismiss(toast.id)}
          style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 2, display: 'flex', flexShrink: 0, marginTop: -1 }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      {pending
        ? <UploadBar progress={toast.progress ?? null} color={color} />
        : (
          <div style={{ height: 2, background: 'var(--bg-elevated)' }}>
            <div style={{ height: '100%', width: `${progress}%`, background: color, transition: 'width 0.05s linear', opacity: 0.6 }} />
          </div>
        )}
    </div>
  )
}

/** Barre d'une notification en cours : mesuree (0..1), ou animee si la progression est inconnue. */
function UploadBar({ progress, color }: { progress: number | null; color: string }) {
  const known = progress !== null
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={known ? Math.round(progress * 100) : undefined}
      data-testid="toast-progress"
      style={{ height: 4, background: 'var(--bg-elevated)', overflow: 'hidden', position: 'relative' }}
    >
      {known
        ? <div style={{ height: '100%', width: `${Math.round(progress * 100)}%`, background: color, transition: 'width 0.15s linear' }} />
        : <div style={{ position: 'absolute', top: 0, bottom: 0, width: '35%', background: color, animation: 'savoire-toast-indeterminate 1.1s ease-in-out infinite' }} />}
    </div>
  )
}

const INDETERMINATE_KEYFRAMES = '@keyframes savoire-toast-indeterminate { 0% { left: -35%; } 100% { left: 100%; } }'

export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => subscribeToasts(setToasts), [])
  // Les envois de pieces jointes s'affichent ici, avec leur progression.
  useEffect(() => showUploadsAsToasts(), [])

  if (toasts.length === 0) return null

  return (
    <div style={{
      position: 'fixed', bottom: 36, right: 16,
      display: 'flex', flexDirection: 'column', gap: 8,
      zIndex: 9000, alignItems: 'flex-end', pointerEvents: 'none',
    }}>
      <style>{INDETERMINATE_KEYFRAMES}</style>
      {toasts.map(t => (
        <div key={t.id} style={{ pointerEvents: 'all' }}>
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  )
}
