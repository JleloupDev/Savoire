// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le telephone en telecommande d'une presentation (code QR de l'ordinateur) :
// les notes du presentateur de la diapositive montree, de grands boutons pour
// avancer et reculer (ou glisser du doigt), le minuteur. L'ecran reste
// allume. Protocole : plugin-api/slideRemote.ts ; transport : slideRemote.ts.
import { useCallback, useEffect, useRef, useState } from 'react'
import { markdownBlock } from '@savoire/editor-core'
import type { SlideRemoteCommand, SlideRemoteLink, SlideScreenState, SyncAPI } from '@savoire/plugin-api'
import { forgetSlideRemote, openRemoteLink, type SlideRemoteTarget } from './slideRemote'

const two = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${two(Math.floor(s / 60))}:${two(s % 60)}` }

const CSS = `
.sr { position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column; background: #111317; color: #ececec; font-family: var(--font-ui, system-ui, sans-serif); user-select: none; -webkit-user-select: none; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
.sr-top { display: flex; align-items: center; gap: 12px; padding: 12px 16px 8px; font-variant-numeric: tabular-nums; }
.sr-count { font-size: 15px; font-weight: 600; }
.sr-step { font-size: 13px; color: #9aa0a6; }
.sr-timer { margin-left: auto; font-size: 20px; }
.sr-quit { all: unset; cursor: pointer; font-size: 13px; color: #9aa0a6; padding: 6px 8px; border: 1px solid #33363d; border-radius: 6px; }
.sr-title { padding: 4px 16px 10px; font-size: 22px; font-weight: 700; line-height: 1.2; color: #fff; }
.sr-notes { flex: 1; min-height: 0; overflow: auto; margin: 0 12px; padding: 14px 16px; border-radius: 10px; background: #1b1e24; font-size: 20px; line-height: 1.5; user-select: text; -webkit-user-select: text; }
.sr-notes .vault-rendered-block { max-width: none; font-family: inherit; }
.sr-notes p, .sr-notes li { color: inherit; margin: 0 0 .5em; }
.sr-notes-empty { color: #777; font-style: italic; }
.sr-next { padding: 8px 16px 0; font-size: 14px; color: #9aa0a6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sr-buttons { display: flex; gap: 10px; padding: 12px; }
.sr-btn { all: unset; flex: 1; text-align: center; padding: 22px 0; border-radius: 12px; font-size: 20px; font-weight: 600; background: #262a31; color: #fff; touch-action: manipulation; }
.sr-btn:active { background: #343943; }
.sr-btn-next { flex: 2; background: var(--accent, #2563eb); }
.sr-btn-next:active { filter: brightness(1.15); }
.sr-btn:disabled { opacity: .4; }
.sr-wait { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 24px; text-align: center; font-size: 17px; color: #b5b5b5; }
`

export function SlideRemotePage({ target, sync, userId, ready, error }: {
  target: SlideRemoteTarget
  sync: SyncAPI
  userId: string | null
  /** Le vault est ouvert : la room peut etre rejointe. */
  ready: boolean
  error: string | null
}) {
  const [state, setState] = useState<SlideScreenState | null>(null)
  const [connectedAt, setConnectedAt] = useState<number | null>(null)
  const [now, setNow] = useState(Date.now())
  const linkRef = useRef<SlideRemoteLink | null>(null)
  const seqRef = useRef(Date.now())
  const notesRef = useRef<HTMLDivElement | null>(null)
  const gotState = useRef(false)

  const send = useCallback((cmd: SlideRemoteCommand, index?: number) => {
    linkRef.current?.send({ role: 'remote', session: target.session, seq: ++seqRef.current, cmd, ...(index !== undefined ? { index } : {}) })
  }, [target.session])

  // La room de la note, puis « bonjour » jusqu'a la reponse de l'ordinateur.
  useEffect(() => {
    if (!ready || !userId) return
    const link = openRemoteLink({ sync, vaultId: target.vaultId, docId: target.docId, userId, session: target.session, url: '', local: false })
    linkRef.current = link
    const off = link.onMessage(m => {
      if (m.role !== 'screen') return
      gotState.current = true
      setState(m)
      setConnectedAt(t => t ?? Date.now())
      if (m.ended) forgetSlideRemote()
    })
    const hello = () => send('hello')
    hello()
    const timer = setInterval(() => { if (!gotState.current) hello() }, 2500)
    // Le telephone se rallume : on redit bonjour (l'etat a pu changer).
    const onVisible = () => { if (document.visibilityState === 'visible') hello() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      off()
      link.send({ role: 'remote', session: target.session, seq: ++seqRef.current, cmd: 'bye' })
      link.close()
      linkRef.current = null
    }
  }, [ready, userId, sync, target, send])

  // Minuteur, et ecran toujours allume.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    type Lock = { release(): Promise<void> }
    let lock: Lock | null = null
    const wake = (navigator as unknown as { wakeLock?: { request(kind: 'screen'): Promise<Lock> } }).wakeLock
    const take = () => { void wake?.request('screen').then(l => { lock = l }, () => {}) }
    take()
    const again = () => { if (document.visibilityState === 'visible') take() }
    document.addEventListener('visibilitychange', again)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', again); void lock?.release().catch(() => {}) }
  }, [])

  // Les notes, rendues comme dans la vue presentateur.
  useEffect(() => {
    const box = notesRef.current
    if (!box) return
    if (state?.notes) box.replaceChildren(markdownBlock(state.notes))
    else {
      const empty = document.createElement('div')
      empty.className = 'sr-notes-empty'
      empty.textContent = 'Pas de notes pour cette diapositive.'
      box.replaceChildren(empty)
    }
    box.scrollTop = 0
  }, [state?.notes, state?.index])

  const press = (cmd: 'next' | 'previous') => {
    navigator.vibrate?.(12)
    send(cmd)
  }

  // Glisser du doigt : vers la gauche, la suite.
  const touch = useRef<{ x: number; y: number } | null>(null)
  const onTouchStart = (e: React.TouchEvent) => { const t = e.touches[0]; if (t) touch.current = { x: t.clientX, y: t.clientY } }
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current
    const t = e.changedTouches[0]
    touch.current = null
    if (!start || !t) return
    const dx = t.clientX - start.x, dy = t.clientY - start.y
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) press(dx < 0 ? 'next' : 'previous')
  }

  const quit = () => {
    forgetSlideRemote()
    window.location.replace('/')
  }

  const waiting = error ?? (!ready ? 'Ouverture du vault…' : !state ? 'Connexion à l’ordinateur…' : null)
  return (
    <div className="sr" data-testid="slide-remote" data-connected={state ? 'true' : 'false'}>
      <style>{CSS}</style>
      <div className="sr-top">
        {state && <span className="sr-count" data-testid="slide-remote-count">{state.index + 1} / {state.count}</span>}
        {state && state.steps > 0 && <span className="sr-step">clic {state.step} / {state.steps}</span>}
        <span className="sr-timer">{connectedAt ? clock(now - connectedAt) : '--:--'}</span>
        <button className="sr-quit" onClick={quit}>Quitter</button>
      </div>
      {waiting || state?.ended ? (
        <div className="sr-wait" data-testid="slide-remote-wait">
          <div>{state?.ended ? 'La présentation est terminée.' : waiting}</div>
          {!state?.ended && !error && <div style={{ fontSize: 14, color: '#777' }}>Gardez la présentation ouverte sur l’ordinateur.</div>}
          {(state?.ended || error) && <button className="sr-btn" style={{ flex: 'none', padding: '14px 28px' }} onClick={quit}>Ouvrir Savoire</button>}
        </div>
      ) : (
        <>
          <div className="sr-title" data-testid="slide-remote-title">{state!.title || `Diapositive ${state!.index + 1}`}</div>
          <div className="sr-notes" data-testid="slide-remote-notes" ref={notesRef} onTouchStart={onTouchStart} onTouchEnd={onTouchEnd} />
          <div className="sr-next">
            {state!.step < state!.steps ? 'Ensuite : la suite de cette diapositive' : state!.nextTitle ? `Ensuite : ${state!.nextTitle}` : state!.index + 1 < state!.count ? 'Ensuite : diapositive sans titre' : 'Dernière diapositive'}
          </div>
          <div className="sr-buttons">
            <button className="sr-btn" data-testid="slide-remote-previous" disabled={state!.index === 0 && state!.step === 0} onClick={() => press('previous')}>‹ Retour</button>
            <button className="sr-btn sr-btn-next" data-testid="slide-remote-next" disabled={state!.index + 1 >= state!.count && state!.step >= state!.steps} onClick={() => press('next')}>Suivante ›</button>
          </div>
        </>
      )}
    </div>
  )
}
