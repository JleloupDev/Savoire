// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'
import type { IAdminAPI, AppAdminUser } from '@savoire/application'
import { t, ti } from '@savoire/i18n'

export function AdminPage({ adminApi }: { adminApi: IAdminAPI }) {
  const { token, isReady, logout } = useAuth()
  const navigate = useNavigate()

  const [users, setUsers] = useState<AppAdminUser[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadUsers = useCallback(async () => {
    if (!token) return
    setLoadError(null)
    try { setUsers(await adminApi.listUsers(token)) }
    catch (e) { setLoadError(String(e)) }
  }, [token])

  useEffect(() => {
    if (!isReady) return
    if (!token) { navigate('/login'); return }
    void loadUsers()
  }, [isReady, token, navigate, loadUsers])

  async function handleDisable(userId: string) {
    if (!token) return
    try { await adminApi.disableUser(token, userId); await loadUsers() } catch { /* POC: ignore */ }
  }

  async function handleLogout() {
    await logout()
    navigate('/login')
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
        <span style={{ fontSize: '0.9rem', fontWeight: 600 }}>{t('app', 'admin.title')}</span>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => navigate('/')} style={topBtn}>{t('app', 'admin.back')}</button>
          <button onClick={handleLogout} style={{ ...topBtn, color: 'var(--color-danger)' }}>{t('app', 'topbar.logout')}</button>
        </div>
      </div>

      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', padding: 16, gap: 16 }}>

        {/* ── Comptes : chez le fournisseur d'identite ── */}
        <div style={{
          width: 300,
          minWidth: 300,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 18,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          flexShrink: 0,
          alignSelf: 'flex-start',
          boxShadow: 'var(--shadow)',
          fontSize: '0.8rem',
          lineHeight: 1.5,
          color: 'var(--text-muted)',
        }}>
          <h3 style={sectionTitle}>Comptes</h3>
          <div>
            Chacun crée son compte depuis l'écran de connexion. Les mots de passe,
            l'inscription et les connexions externes se gèrent dans la console
            du fournisseur d'identité (Zitadel).
          </div>
          <div>
            Un compte apparaît ici à sa première connexion. Le bloquer lui ferme
            Savoire, même si sa connexion reste valide chez le fournisseur.
          </div>
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
            <h3 style={sectionTitle}>{ti('app', 'admin.list.title', { count: String(users.length) })}</h3>
            <button onClick={loadUsers} style={{
              padding: '3px 10px',
              background: 'var(--bg-elevated)',
              color: 'var(--text-muted)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius)',
              fontSize: '0.72rem',
            }}>{t('app', 'admin.refresh')}</button>
          </div>

          {loadError && <div style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{loadError}</div>}
          {users.length === 0 && !loadError && (
            <div style={{ color: 'var(--text-faint)', fontSize: '0.8rem' }}>{t('app', 'admin.list.loading')}</div>
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
                    }}>{t('app', 'admin.user.badge.admin')}</span>
                  )}
                  {user.isLockedOut && (
                    <span style={{
                      fontSize: '0.6rem',
                      background: 'var(--color-danger)',
                      color: 'white',
                      padding: '1px 6px',
                      borderRadius: 8,
                      fontWeight: 700,
                    }}>{t('app', 'admin.user.badge.disabled')}</span>
                  )}
                </div>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{user.email}</span>
                <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)' }}>
                  Créé le {new Date(user.createdAt).toLocaleString('fr-FR')}
                  {user.lastLoginAt && ` · Dernier login ${new Date(user.lastLoginAt).toLocaleString('fr-FR')}`}
                </span>
              </div>

              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {!user.isLockedOut && (
                  <button onClick={() => handleDisable(user.id)} title="Bloquer le compte" data-testid="admin-disable" style={{
                    padding: '3px 8px', background: 'var(--bg-elevated)', color: 'var(--color-danger)',
                    border: '1px solid var(--border)', borderRadius: 3, fontSize: '0.72rem',
                  }}>Bloquer</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
