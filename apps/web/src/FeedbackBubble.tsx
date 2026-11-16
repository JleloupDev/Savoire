// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La bulle de retour, en bas a droite : la personne dit ce qu'elle aimerait
// changer. Au clic, l'ecran est capture (avant l'ouverture du panneau, pour
// qu'il n'y soit pas) ; elle voit la capture et peut la retirer. Le message,
// la capture et le contexte partent au serveur (voir feedback.ts).
// Pour l'instant, la bulle est la pour tous les comptes connectes.
import { useState } from 'react'
import { Icon } from '@savoire/ui-components'
import { notify } from '@savoire/notifications'
import { useAuth } from './AuthContext'
import { FEEDBACK_IGNORE_ATTR, captureScreen, collectFeedbackContext, submitFeedback } from './feedback'

const BTN: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', border: '1px solid var(--accent)', color: 'var(--accent-text, #fff)', fontWeight: 600 }

interface Draft {
  message: string
  screenshot: string | null
  includeScreenshot: boolean
  context: Record<string, unknown>
}

export function FeedbackBubble() {
  const { token } = useAuth()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!token) return null

  async function open() {
    if (capturing) return
    setCapturing(true)
    setError(null)
    // Contexte et capture de l'ecran tel que la personne le voit maintenant.
    const context = collectFeedbackContext()
    const screenshot = await captureScreen()
    setCapturing(false)
    setDraft({ message: '', screenshot, includeScreenshot: screenshot !== null, context })
  }

  async function send() {
    if (!draft || !token || !draft.message.trim()) return
    setSending(true)
    setError(null)
    try {
      await submitFeedback(token, {
        message: draft.message.trim(),
        context: draft.context,
        screenshot: draft.includeScreenshot ? draft.screenshot : null,
      })
      setDraft(null)
      notify('success', 'Merci ! Votre retour est envoyé.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div {...{ [FEEDBACK_IGNORE_ATTR]: '' }}>
      {draft && (
        <div role="dialog" aria-label="Envoyer un retour" data-testid="feedback-panel" style={{
          position: 'fixed', right: 16, bottom: 88, width: 340, maxWidth: 'calc(100vw - 32px)', zIndex: 9001,
          background: 'var(--bg-surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10,
          boxShadow: 'var(--shadow)', padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
          fontFamily: 'var(--font-ui)', fontSize: 13,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <strong>Votre retour</strong>
            <button onClick={() => setDraft(null)} aria-label="Fermer" style={{ ...BTN, border: 'none', padding: 2 }}><Icon name="x" size={14} /></button>
          </div>
          <textarea
            autoFocus
            value={draft.message}
            onChange={e => setDraft({ ...draft, message: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send() }}
            placeholder="Qu'aimeriez-vous changer ou améliorer ? Qu'est-ce qui vous a gêné ?"
            maxLength={5000}
            rows={5}
            data-testid="feedback-message"
            style={{
              resize: 'vertical', padding: 8, borderRadius: 6, border: '1px solid var(--border)',
              background: 'var(--bg-elevated)', color: 'var(--text)', font: 'inherit',
            }}
          />
          {draft.screenshot ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <img src={draft.screenshot} alt="Capture de l'écran" style={{
                width: '100%', maxHeight: 160, objectFit: 'contain', borderRadius: 6,
                border: '1px solid var(--border)', opacity: draft.includeScreenshot ? 1 : 0.35,
              }} />
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-muted)' }}>
                <input type="checkbox" checked={draft.includeScreenshot}
                  onChange={e => setDraft({ ...draft, includeScreenshot: e.target.checked })} />
                Joindre la capture (elle montre vos notes à l'écran)
              </label>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Capture impossible : le retour partira sans image.</div>
          )}
          {error && <div style={{ color: 'var(--color-danger)', fontSize: 12 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button onClick={() => setDraft(null)} style={BTN}>Annuler</button>
            <button onClick={send} disabled={sending || !draft.message.trim()} data-testid="feedback-send"
              style={{ ...PRIMARY, opacity: sending || !draft.message.trim() ? 0.6 : 1 }}>
              {sending ? 'Envoi…' : 'Envoyer'}
            </button>
          </div>
        </div>
      )}
      <button
        onClick={() => (draft ? setDraft(null) : void open())}
        title="Un retour sur l'application ?"
        aria-label="Envoyer un retour"
        data-testid="feedback-bubble"
        style={{
          position: 'fixed', right: 16, bottom: 36, zIndex: 9001, width: 44, height: 44, borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: capturing ? 'progress' : 'pointer',
          background: 'var(--accent)', color: 'var(--accent-text, #fff)', border: 'none', boxShadow: 'var(--shadow)',
        }}
      >
        <Icon name={capturing ? 'refresh-cw' : 'message-square-plus'} size={20} />
      </button>
    </div>
  )
}
