// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { api } from './api'
import type { AdminUserDto } from './types'

export function AdminPage() {
  const { token, isReady, logout } = useAuth()
  const navigate = useNavigate()

  const [users, setUsers] = useState<AdminUserDto[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [newEmail, setNewEmail] = useState('')
  const [newDisplayName, setNewDisplayName] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newIsAdmin, setNewIsAdmin] = useState(false)
  const [createLoading, setCreateLoading] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createSuccess, setCreateSuccess] = useState<string | null>(null)

  const [resetTarget, setResetTarget] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')

  const loadUsers = useCallback(async () => {
    if (!token) return
    setLoadError(null)
    try { setUsers(await api.listUsers(token)) }
    catch (e) { setLoadError(String(e)) }
  }, [token])

  useEffect(() => {
    if (!isReady) return
    if (!token) { navigate('/login'); return }
    void loadUsers()
  }, [isReady, token, navigate, loadUsers])

  async function createUser() {
    if (!token || !newEmail || !newPassword || !newDisplayName) return
    setCreateLoading(true)
    setCreateError(null)
    setCreateSuccess(null)
    try {
      await api.createUser(token, newEmail.trim(), newPassword, newDisplayName.trim(), newIsAdmin)
      setCreateSuccess(`Utilisateur ${newEmail} créé.`)
      setNewEmail(''); setNewDisplayName(''); setNewPassword(''); setNewIsAdmin(false)
      await loadUsers()
    } catch (e) { setCreateError(String(e)) }
    finally { setCreateLoading(false) }
  }

  async function confirmReset(userId: string) {
    if (!token || !resetPassword) return
    try { await api.resetPassword(token, userId, resetPassword); setResetTarget(null); setResetPassword('') }
    catch (e) { setLoadError(String(e)) }
  }

  async function handleRevoke(userId: string) {
    if (!token) return
    try { await api.revokeSessions(token, userId) } catch { /* POC: ignore */ }
  }

  async function handleDisable(userId: string) {
    if (!token) return
    try { await api.disableUser(token, userId); await loadUsers() } catch { /* POC: ignore */ }
  }

  async function handleLogout() {
    await logout()
    navigate('/login')
  }

  const inp: React.CSSProperties = {
    padding: '6px 8px',
    background: 'var(--bg-base)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: '0.8rem',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  }

  const topBtn: React.CSSProperties = {
    padding: '4px 12px',
    background: 'var(--bg-elevated)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: '0.8rem',
  }

  const sectionTitle: React.CSSProperties = {
    margin: 0,
    fontSize: '0.72rem',
    fontWeight: 700,
    color: 'var(--text-faint)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  }

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      background: 'var(--bg-base)',
      color: 'var(--text)',
      fontFamily: 'var(--font-ui)',
      flexDirection: 'column',
    }}>

      {/* ── Topbar ── */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '6px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg-surface)',
        minHeight: 42,
        flexShrink: 0,
      }}>
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>Administration — Utilisateurs</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => navigate('/')} style={topBtn}>← Éditeur</button>
          <button onClick={handleLogout} style={{ ...topBtn, color: 'var(--color-danger)' }}>Déconnexion</button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', padding: 16, gap: 16 }}>

        {/* ── Create form ── */}
        <div style={{
          width: 300,
          minWidth: 300,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          flexShrink: 0,
          alignSelf: 'flex-start',
          boxShadow: 'var(--shadow)',
        }}>
          <h3 style={sectionTitle}>Créer un utilisateur</h3>

          {createError && (
            <div style={{
              background: `color-mix(in srgb, var(--color-danger) 12%, var(--bg-base))`,
              color: 'var(--color-danger)',
              padding: '6px 10px',
              borderRadius: 'var(--radius)',
              fontSize: '0.75rem',
              border: `1px solid color-mix(in srgb, var(--color-danger) 35%, var(--border))`,
            }}>{createError}</div>
          )}
          {createSuccess && (
            <div style={{
              background: `color-mix(in srgb, var(--color-success) 12%, var(--bg-base))`,
              color: 'var(--color-success)',
              padding: '6px 10px',
              borderRadius: 'var(--radius)',
              fontSize: '0.75rem',
              border: `1px solid color-mix(in srgb, var(--color-success) 35%, var(--border))`,
            }}>{createSuccess}</div>
          )}

          {[
            { label: 'Email', type: 'email', value: newEmail, set: setNewEmail, ph: 'user@example.com' },
            { label: 'Nom affiché', type: 'text', value: newDisplayName, set: setNewDisplayName, ph: 'Jean Dupont' },
            { label: 'Mot de passe', type: 'password', value: newPassword, set: setNewPassword, ph: 'Min. 8 caractères' },
          ].map(({ label, type, value, set, ph }) => (
            <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <label style={{ fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 500 }}>{label}</label>
              <input type={type} value={value} onChange={e => set(e.target.value)} placeholder={ph} style={inp} />
            </div>
          ))}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input
              type="checkbox"
              id="isAdmin"
              checked={newIsAdmin}
              onChange={e => setNewIsAdmin(e.target.checked)}
              style={{ accentColor: 'var(--accent)', width: 14, height: 14 }}
            />
            <label htmlFor="isAdmin" style={{ fontSize: '0.82rem', cursor: 'pointer' }}>Administrateur</label>
          </div>

          <button
            onClick={createUser}
            disabled={createLoading || !newEmail || !newPassword || !newDisplayName}
            style={{
              padding: '8px 0',
              background: 'var(--accent)',
              color: 'white',
              border: 'none',
              borderRadius: 'var(--radius)',
              fontSize: '0.85rem',
              fontWeight: 600,
              opacity: (createLoading || !newEmail || !newPassword || !newDisplayName) ? 0.5 : 1,
            }}
          >
            {createLoading ? 'Création…' : "Créer l'utilisateur"}
          </button>
        </div>

        {/* ── User list ── */}
        <div style={{
          flex: 1,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          overflowY: 'auto',
          boxShadow: 'var(--shadow)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3 style={sectionTitle}>Utilisateurs ({users.length})</h3>
            <button onClick={loadUsers} style={{
              padding: '3px 10px',
              background: 'var(--bg-elevated)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: '0.72rem',
            }}>Rafraîchir</button>
          </div>

          {loadError && <div style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{loadError}</div>}
          {users.length === 0 && !loadError && (
            <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>Chargement…</div>
          )}

          {users.map(user => (
            <div key={user.id} style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '10px 14px',
              background: 'var(--bg-base)',
              borderRadius: 'var(--radius)',
              border: '1px solid var(--border)',
              gap: 8,
            }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.88rem', fontWeight: 600 }}>{user.displayName}</span>
                  {user.isAdmin && (
                    <span style={{
                      fontSize: '0.6rem',
                      background: 'var(--color-info)',
                      color: 'white',
                      padding: '1px 6px',
                      borderRadius: 8,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                    }}>ADMIN</span>
                  )}
                  {user.isLockedOut && (
                    <span style={{
                      fontSize: '0.6rem',
                      background: 'var(--color-danger)',
                      color: 'white',
                      padding: '1px 6px',
                      borderRadius: 8,
                      fontWeight: 700,
                    }}>DÉSACTIVÉ</span>
                  )}
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{user.email}</span>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)' }}>
                  Créé le {new Date(user.createdAt).toLocaleString('fr-FR')}
                  {user.lastLoginAt && ` · Dernier login ${new Date(user.lastLoginAt).toLocaleString('fr-FR')}`}
                </span>
              </div>

              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {resetTarget === user.id ? (
                  <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                    <input
                      type="password"
                      value={resetPassword}
                      onChange={e => setResetPassword(e.target.value)}
                      placeholder="Nouveau mdp"
                      style={{ ...inp, width: 120, padding: '3px 6px', fontSize: '0.72rem' }}
                    />
                    <button onClick={() => confirmReset(user.id)} disabled={!resetPassword} style={{
                      padding: '3px 8px', background: 'var(--bg-elevated)', color: 'var(--color-success)',
                      border: '1px solid var(--border)', borderRadius: 3, fontSize: '0.7rem',
                    }}>OK</button>
                    <button onClick={() => { setResetTarget(null); setResetPassword('') }} style={{
                      padding: '3px 8px', background: 'var(--bg-elevated)', color: 'var(--color-danger)',
                      border: '1px solid var(--border)', borderRadius: 3, fontSize: '0.7rem',
                    }}>Ann.</button>
                  </div>
                ) : (
                  <>
                    <button onClick={() => setResetTarget(user.id)} title="Réinitialiser le mot de passe" style={{
                      padding: '3px 8px', background: 'var(--bg-elevated)', color: 'var(--color-warn)',
                      border: '1px solid var(--border)', borderRadius: 3, fontSize: '0.72rem',
                    }}>🔑 Reset</button>
                    <button onClick={() => handleRevoke(user.id)} title="Révoquer toutes les sessions" style={{
                      padding: '3px 8px', background: 'var(--bg-elevated)', color: 'var(--color-info)',
                      border: '1px solid var(--border)', borderRadius: 3, fontSize: '0.72rem',
                    }}>🔒 Sessions</button>
                    {!user.isLockedOut && (
                      <button onClick={() => handleDisable(user.id)} title="Désactiver le compte" style={{
                        padding: '3px 8px', background: 'var(--bg-elevated)', color: 'var(--color-danger)',
                        border: '1px solid var(--border)', borderRadius: 3, fontSize: '0.72rem',
                      }}>✕</button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
