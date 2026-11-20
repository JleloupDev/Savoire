// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Parametres → Compte : exporter ses donnees (.zip), supprimer son compte,
// voir si l'inscription est ouverte. L'inscription se ferme sur le serveur
// (SIGNUP_CLOSED, zitadel-bootstrap) : ici on ne fait que la montrer.
import { useEffect, useState } from 'react'
import { DELETE_CONFIRMATION, type AccountProfile } from './accountData'

export interface AccountSettingsProps {
  /** Le compte connecte (GET /api/v1/auth/me). */
  loadProfile(): Promise<AccountProfile>
  /** Cree l'archive et la remet a la personne. Rend un message de fin. */
  exportData(): Promise<string>
  /** Supprime le compte, puis ferme la session. */
  deleteAccount(): Promise<void>
}

const BTN: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const SECTION: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 0', borderBottom: '1px solid var(--border)' }
const TITLE: React.CSSProperties = { margin: 0, fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.08em' }

export function AccountSettings({ loadProfile, exportData, deleteAccount }: AccountSettingsProps) {
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState<string | null>(null)

  useEffect(() => { void loadProfile().then(setProfile, () => setProfile(null)) }, [loadProfile])

  const run = async (kind: 'export' | 'delete', job: () => Promise<string | void>) => {
    setBusy(kind); setError(null); setMessage(null)
    try { const done = await job(); if (done) setMessage(done) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }

  return (
    <div data-testid="account-settings" style={{ display: 'flex', flexDirection: 'column', fontSize: 12, color: 'var(--text)' }}>
      {profile && (
        <div style={SECTION}>
          <h3 style={TITLE}>Compte</h3>
          <div>{profile.displayName}{profile.email ? ` · ${profile.email}` : ''}</div>
        </div>
      )}

      <div style={SECTION}>
        <h3 style={TITLE}>Exporter mes données</h3>
        <div style={{ color: 'var(--text-muted)' }}>
          Une archive .zip avec votre profil et, dossier par dossier, tous les vaults dont vous êtes propriétaire.
        </div>
        <div><button data-testid="account-export" style={BTN} disabled={busy !== null} onClick={() => void run('export', exportData)}>
          {busy === 'export' ? 'Préparation…' : 'Exporter mes données'}
        </button></div>
      </div>

      {profile?.isAdmin && (
        <div style={SECTION}>
          <h3 style={TITLE}>Inscription</h3>
          <div data-testid="account-signup" style={{ color: 'var(--text-muted)' }}>
            {profile.signupClosed
              ? 'Fermée : personne ne peut créer de compte seul. Les comptes existants, et ceux que vous créez dans la console Zitadel, se connectent.'
              : 'Ouverte : chacun peut créer son compte depuis l\'écran de connexion.'}
            {' '}Pour la changer, mettez SIGNUP_CLOSED={profile.signupClosed ? 'false' : 'true'} dans le fichier .env du serveur, puis relancez zitadel-bootstrap.
          </div>
        </div>
      )}

      <div style={SECTION}>
        <h3 style={{ ...TITLE, color: 'var(--color-danger, #cf222e)' }}>Supprimer mon compte</h3>
        <div style={{ color: 'var(--text-muted)' }}>
          Efface votre compte et les vaults dont vous êtes propriétaire, pour de bon. Vous quittez ceux des autres. Pensez à exporter vos données d'abord.
        </div>
        {typed === null
          ? <div><button data-testid="account-delete" style={{ ...BTN, color: 'var(--color-danger, #cf222e)' }} onClick={() => setTyped('')}>Supprimer mon compte…</button></div>
          : (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input data-testid="account-delete-confirm" value={typed} onChange={e => setTyped(e.target.value)} placeholder={`Tapez ${DELETE_CONFIRMATION}`}
                style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', font: 'inherit', fontSize: 12 }} />
              <button data-testid="account-delete-go" style={{ ...BTN, background: 'var(--color-danger, #cf222e)', borderColor: 'var(--color-danger, #cf222e)', color: '#fff' }}
                disabled={typed !== DELETE_CONFIRMATION || busy !== null} onClick={() => void run('delete', async () => { await deleteAccount() })}>
                {busy === 'delete' ? 'Suppression…' : 'Supprimer définitivement'}
              </button>
              <button style={BTN} onClick={() => setTyped(null)}>Annuler</button>
            </div>
          )}
      </div>

      {message && <div data-testid="account-message" style={{ paddingTop: 10, color: 'var(--color-success, #1a7f37)' }}>{message}</div>}
      {error && <div data-testid="account-error" style={{ paddingTop: 10, color: 'var(--color-danger, #cf222e)' }}>{error}</div>}
    </div>
  )
}
