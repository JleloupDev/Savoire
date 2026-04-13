// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { api } from './api'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const { token, login } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (token) navigate('/', { replace: true })
  }, [token, navigate])

  async function handleLogin() {
    if (!email || !password) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.login(email.trim(), password)
      login(res)
      navigate('/')
    } catch (e) {
      const msg = String(e)
      setError(msg.includes('401') ? 'Email ou mot de passe incorrect.' : `Erreur serveur : ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter') handleLogin()
  }

  const inp: React.CSSProperties = {
    padding: '8px 10px',
    background: 'var(--bg-base)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    fontSize: '0.85rem',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box',
  }

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-base)',
      fontFamily: 'var(--font-ui)',
    }}>
      <div style={{
        width: 380,
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 36,
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        boxShadow: 'var(--shadow)',
      }}>
        <div style={{ textAlign: 'center' }}>
          <h2 style={{ margin: 0, color: 'var(--text)', fontSize: '1.3rem', fontWeight: 700 }}>
            POC Collab Editor
          </h2>
          <p style={{ margin: '5px 0 0', color: 'var(--text-faint)', fontSize: '0.8rem' }}>
            Connexion à votre compte
          </p>
        </div>

        {error && (
          <div style={{
            background: `color-mix(in srgb, var(--color-danger) 12%, var(--bg-base))`,
            color: 'var(--color-danger)',
            padding: '8px 12px',
            borderRadius: 'var(--radius)',
            fontSize: '0.8rem',
            border: `1px solid color-mix(in srgb, var(--color-danger) 40%, var(--border))`,
          }}>
            {error}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>Email</label>
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyUp={onKey}
            placeholder="admin@local.dev"
            style={inp}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 500 }}>Mot de passe</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            onKeyUp={onKey}
            placeholder="••••••••"
            style={inp}
          />
        </div>

        <button
          onClick={handleLogin}
          disabled={loading || !email || !password}
          style={{
            padding: '10px 0',
            background: loading ? 'var(--bg-elevated)' : 'var(--accent)',
            color: loading ? 'var(--text-muted)' : 'white',
            border: 'none',
            borderRadius: 'var(--radius)',
            fontSize: '0.9rem',
            fontWeight: 600,
            opacity: (!email || !password) ? 0.5 : 1,
          }}
        >
          {loading ? 'Connexion…' : 'Se connecter'}
        </button>

        <div style={{ fontSize: '0.7rem', color: 'var(--text-faint)', textAlign: 'center' }}>
          Identifiants dev local : admin@local.dev / Admin1234!
        </div>
      </div>
    </div>
  )
}
