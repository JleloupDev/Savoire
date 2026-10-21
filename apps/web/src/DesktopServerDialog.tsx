// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Version bureau : le bouton serveur (toujours visible dans la barre du haut)
// et sa fenetre. Le bouton dit ou l'on en est (serveur et compte, ou « Hors
// ligne »). La fenetre choisit le serveur (adresses connues, ou saisie) puis
// connecte ou deconnecte le compte. Un seul compte a la fois. Le vault ouvert
// reste ouvert : seul un vault DU SERVEUR se ferme a la deconnexion.

import { useEffect, useState } from 'react'
import { t } from '@savoire/i18n'
import { ServerAddressError } from '@savoire/infrastructure-sync'
import { getServerChoice, subscribeServerChoice, type ServerChoice } from './serverConnection'
import { describeLoginError } from './serverErrors'
import { serverLabel, type ServerStatus } from './desktopConnection'

/** Le choix du serveur, suivi (il change quand on se connecte ailleurs). */
export function useServerChoice(): ServerChoice {
  const [choice, setChoice] = useState<ServerChoice>(getServerChoice)
  useEffect(() => subscribeServerChoice(setChoice), [])
  return choice
}

const dotColor: Record<ServerStatus['state'], string> = {
  connected: 'var(--color-success)',
  offline: 'var(--color-warning, #d9a400)',
  none: 'var(--text-faint)',
}

export function ServerButton({ status, onClick }: { status: ServerStatus; onClick: () => void }) {
  const title = status.state === 'connected'
    ? `Connecté à ${status.server} en tant que ${status.account?.displayName} (${status.account?.email}). Cliquer pour changer.`
    : status.state === 'offline'
      ? `Compte ${status.account?.email} gardé, mais ${status.server} ne répond pas. Cliquer pour réessayer ou changer de serveur.`
      : 'Aucun serveur connecté. Cliquer pour choisir un serveur et se connecter.'
  return (
    <button
      data-testid="server-button"
      data-server-state={status.state}
      onClick={onClick}
      title={title}
      style={{ display: 'flex', alignItems: 'center', gap: 6, maxWidth: 280, padding: '3px 9px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', fontSize: 11.5, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-ui)', flexShrink: 0 }}
    >
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor[status.state], flexShrink: 0 }} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status.label}</span>
    </button>
  )
}

const btn: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text)', cursor: 'pointer',
  fontSize: 13, fontFamily: 'var(--font-ui)',
}
const input: React.CSSProperties = {
  padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-base)', color: 'var(--text)', fontSize: 13,
  fontFamily: 'var(--font-ui)', width: '100%', boxSizing: 'border-box',
}
const label: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-muted)' }

export function DesktopServerDialog({ status, defaultServer, onConnect, onDisconnect, onRetry, onClose }: {
  status: ServerStatus
  /** Adresse proposee quand aucun serveur n'est encore choisi. */
  defaultServer: string
  /** Se connecter (remplace le compte precedent). Rejette avec l'erreur d'origine. */
  onConnect: (server: string, email: string, password: string) => Promise<void>
  onDisconnect: () => Promise<void>
  /** Compte garde, serveur injoignable : reessayer la session gardee. */
  onRetry: () => Promise<boolean>
  onClose: () => void
}) {
  const choice = useServerChoice()
  const [server, setServer] = useState(choice.current ?? defaultServer)
  const [email, setEmail] = useState(status.account?.email ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } finally {
      setBusy(false)
    }
  }

  function connect() {
    if (!server.trim() || !email.trim() || !password) return
    void run(async () => {
      try {
        await onConnect(server, email, password)
        setPassword('')
        onClose()
      } catch (err) {
        setError(err instanceof ServerAddressError
          ? err.message
          : describeLoginError(err, { server: server.trim(), credentials: t('app', 'login.error.credentials') }))
      }
    })
  }

  const known = choice.servers
  return (
    <div data-testid="server-dialog" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ width: 460, maxWidth: '92vw', maxHeight: '86vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow)', position: 'relative', fontFamily: 'var(--font-ui)', color: 'var(--text)' }}>
        <button onClick={onClose} title="Fermer" style={{ position: 'absolute', top: 12, right: 14, background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer' }}>✕</button>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Serveur Savoire</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 4 }}>
            Connecté, les vaults de votre compte s'ajoutent à ceux de cet ordinateur. Un seul compte à la fois.
          </div>
        </div>

        {/* Etat actuel */}
        <div data-testid="server-dialog-status" style={{ padding: '10px 12px', borderRadius: 8, background: 'var(--bg-elevated)', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {status.state === 'connected' && <>Connecté à <strong>{serverLabel(status.server)}</strong><div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{status.account?.displayName} · {status.account?.email}</div></>}
            {status.state === 'offline' && <>Hors ligne : <strong>{serverLabel(status.server)}</strong> ne répond pas<div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Compte gardé : {status.account?.email}</div></>}
            {status.state === 'none' && <>Hors ligne · non connecté</>}
          </div>
          {status.state === 'offline' && (
            <button data-testid="server-retry" disabled={busy} style={btn} onClick={() => void run(async () => {
              if (!await onRetry()) setError(`Le serveur ${status.server} ne répond toujours pas, ou la session a expiré.`)
            })}>Réessayer</button>
          )}
          {status.state !== 'none' && (
            <button data-testid="server-disconnect" disabled={busy} style={{ ...btn, color: 'var(--color-danger)' }} onClick={() => void run(async () => {
              await onDisconnect()
              setPassword('')
            })}>Se déconnecter</button>
          )}
        </div>

        {error && (
          <div data-testid="server-dialog-error" style={{ padding: '9px 12px', borderRadius: 6, border: '1px solid color-mix(in srgb, var(--color-danger) 30%, var(--border))', color: 'var(--color-danger)', fontSize: 12.5 }}>
            {error}
          </div>
        )}

        {/* Choix du serveur et connexion */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>{status.state === 'connected' ? 'Changer de serveur ou de compte' : 'Serveur'}</span>
          {known.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {known.map(s => (
                <button
                  key={s}
                  data-testid="server-known"
                  data-server={s}
                  onClick={() => setServer(s)}
                  style={{ padding: '3px 9px', borderRadius: 12, border: '1px solid var(--border)', fontSize: 11.5, cursor: 'pointer', fontFamily: 'var(--font-ui)', background: s === server ? 'var(--accent-dim)' : 'transparent', color: s === server ? 'var(--accent)' : 'var(--text-muted)' }}
                >
                  {serverLabel(s)}{s === choice.current ? ' ●' : ''}
                </button>
              ))}
            </div>
          )}
          <input data-testid="server-address" style={input} value={server} placeholder={defaultServer} onChange={e => setServer(e.target.value)} onKeyDown={e => e.key === 'Enter' && connect()} />
          <div style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>
            Par exemple https://savoire.exemple.fr, ou {defaultServer} (tunnel SSH vers le serveur).
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={label}>{t('app', 'login.email')}</span>
          <input data-testid="server-email" style={input} type="email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === 'Enter' && connect()} />
          <span style={label}>{t('app', 'login.password')}</span>
          <input data-testid="server-password" style={input} type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === 'Enter' && connect()} />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btn}>Fermer</button>
          <button
            data-testid="server-connect"
            disabled={busy || !server.trim() || !email.trim() || !password}
            onClick={connect}
            style={{ ...btn, background: 'var(--accent)', color: 'var(--accent-text, #fff)', border: 'none', opacity: (!server.trim() || !email.trim() || !password) ? 0.5 : 1 }}
          >
            {busy ? t('app', 'login.submitting') : status.state === 'connected' ? 'Se connecter (remplace le compte)' : 'Se connecter'}
          </button>
        </div>
      </div>
    </div>
  )
}
