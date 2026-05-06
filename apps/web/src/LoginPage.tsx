// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useEffect, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { api } from './api'
import { t } from '@savoire/i18n'

const FEATURES: Array<{ icon: string; key: 'login.feature.markdown' | 'login.feature.wikilinks' | 'login.feature.collab' | 'login.feature.plugins' }> = [
  { icon: '📝', key: 'login.feature.markdown' },
  { icon: '🔗', key: 'login.feature.wikilinks' },
  { icon: '⚡', key: 'login.feature.collab' },
  { icon: '🧩', key: 'login.feature.plugins' },
]

function InputField({
  label, type, value, onChange, placeholder, onEnter,
}: {
  label: string
  type: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  onEnter: () => void
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyUp={(e: KeyboardEvent) => e.key === 'Enter' && onEnter()}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        style={{
          padding: '9px 11px',
          background: 'var(--bg-base)',
          color: 'var(--text)',
          border: `1px solid ${focused ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 'var(--radius)',
          fontSize: 13.5,
          outline: 'none',
          boxShadow: focused ? '0 0 0 3px var(--accent-dim)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          fontFamily: 'var(--font-ui)',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
    </div>
  )
}

export function LoginPage() {
  const [email, setEmail]       = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState<string | null>(null)
  const [loading, setLoading]   = useState(false)
  const { token, login }        = useAuth()
  const navigate                = useNavigate()

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
      setError(msg.includes('401') ? t('app', 'login.error.credentials') : `Erreur serveur : ${msg}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ height: '100vh', display: 'flex', background: 'var(--bg-base)', fontFamily: 'var(--font-ui)', overflow: 'hidden' }}>

      {/* ── Left panel — brand ── */}
      <div style={{ flex: 1, background: 'var(--accent)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '48px 56px', position: 'relative', overflow: 'hidden' }}>

        {/* Subtle grid texture */}
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.06 }} xmlns="http://www.w3.org/2000/svg">
          <defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="white" strokeWidth="0.5"/></pattern></defs>
          <rect width="100%" height="100%" fill="url(#grid)"/>
        </svg>

        {/* Logo wordmark — tout blanc */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
          <svg width="120" height="36" viewBox="0 0 120 36" fill="none">
            <path d="M8 4 L3 9 L3 18 L3 27 L8 32" stroke="var(--on-accent)" strokeWidth="2.8" strokeLinecap="round" fill="none"/>
            <path d="M16 4 L11 9 L11 18 L11 27 L16 32" stroke="var(--on-accent-muted)" strokeWidth="2.8" strokeLinecap="round" fill="none"/>
            <text x="24" y="25" fontFamily="'Source Serif 4',serif" fontSize="20" fontWeight="700" fill="var(--accent-text)" letterSpacing="-0.3">Savoire</text>
            <path d="M104 4 L109 9 L109 18 L109 27 L104 32" stroke="var(--on-accent-muted)" strokeWidth="2.8" strokeLinecap="round" fill="none"/>
            <path d="M112 4 L117 9 L117 18 L117 27 L112 32" stroke="var(--on-accent)" strokeWidth="2.8" strokeLinecap="round" fill="none"/>
          </svg>
        </div>

        {/* Hero text */}
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 38, fontWeight: 700, color: 'var(--on-accent)', lineHeight: 1.15, letterSpacing: '-0.02em', fontFamily: 'var(--font-editor, var(--font-ui))', marginBottom: 16 }}>
            Votre base de<br />connaissances,<br />vraiment à vous.
          </div>
          <div style={{ fontSize: 15, color: 'var(--on-accent-muted)', lineHeight: 1.6, maxWidth: 320, marginBottom: 40 }}>
            Open source, local-first, auto-hébergeable. Collaborez en temps réel sans sacrifier votre vie privée.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {FEATURES.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--on-accent-dim)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: 'white', fontFamily: 'var(--font-code)', fontWeight: 600, flexShrink: 0 }}>{f.icon}</div>
                <span style={{ fontSize: 13.5, color: 'var(--on-accent)' }}>{t('app', f.key)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ fontSize: 12, color: 'var(--on-accent-faint)', position: 'relative' }}>
          AGPL-3.0 · Open source · Self-hostable
        </div>
      </div>

      {/* ── Right panel — form ── */}
      <div style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '48px 52px', background: 'var(--bg-surface)', borderLeft: '1px solid var(--border)', position: 'relative' }}>

        {/* Heading avec logo brackets colorés */}
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
              <path d="M7 3 L3 7 L3 16 L3 25 L7 29" stroke="var(--logo-bracket-1)" strokeWidth="3" strokeLinecap="round" fill="none"/>
              <path d="M13 3 L9 7 L9 16 L9 25 L13 29" stroke="var(--logo-bracket-2)" strokeWidth="3" strokeLinecap="round" fill="none"/>
              <path d="M25 3 L29 7 L29 16 L29 25 L25 29" stroke="var(--logo-bracket-1)" strokeWidth="3" strokeLinecap="round" fill="none"/>
              <path d="M19 3 L23 7 L23 16 L23 25 L19 29" stroke="var(--logo-bracket-2)" strokeWidth="3" strokeLinecap="round" fill="none"/>
            </svg>
            <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', fontFamily: 'var(--font-editor, var(--font-ui))' }}>Savoire</span>
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', letterSpacing: '-0.02em', fontFamily: 'var(--font-editor, var(--font-ui))', marginBottom: 6 }}>{t('app', 'login.title')}</div>
          <div style={{ fontSize: 14, color: 'var(--text-faint)', lineHeight: 1.5 }}>{t('app', 'login.subtitle')}</div>
        </div>

        {/* Error */}
        {error && (
          <div style={{ padding: '10px 14px', background: `color-mix(in srgb, var(--color-danger) 10%, var(--bg-base))`, borderRadius: 'var(--radius)', border: '1px solid color-mix(in srgb, var(--color-danger) 30%, var(--border))', color: 'var(--color-danger)', fontSize: 13, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 15 }}>⚠</span>{error}
          </div>
        )}

        {/* Fields */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginBottom: 24 }}>
          <InputField label={t('app', 'login.email')} type="email" value={email} onChange={setEmail} placeholder="admin@local.dev" onEnter={handleLogin} />
          <div>
            <InputField label={t('app', 'login.password')} type="password" value={password} onChange={setPassword} placeholder="••••••••" onEnter={handleLogin} />
            <div style={{ textAlign: 'right', marginTop: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--accent)', cursor: 'pointer' }}>{t('app', 'login.forgot')}</span>
            </div>
          </div>
        </div>

        {/* Submit */}
        <button
          onClick={handleLogin}
          disabled={loading || !email || !password}
          style={{ padding: 11, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none', borderRadius: 'var(--radius)', fontSize: 14, fontWeight: 600, cursor: (!email || !password || loading) ? 'not-allowed' : 'pointer', opacity: (!email || !password) ? 0.45 : 1, transition: 'opacity 0.15s, filter 0.12s', letterSpacing: '0.01em', marginBottom: 28, width: '100%', fontFamily: 'var(--font-ui)' }}
        >
          {loading ? t('app', 'login.submitting') : t('app', 'login.submit')}
        </button>

        {/* Divider */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>ou</span>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        {/* SSO */}
        <button style={{ padding: 10, borderRadius: 'var(--radius)', border: '1px solid var(--border)', background: 'transparent', fontSize: 13.5, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-ui)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 28, width: '100%' }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          Continuer avec SSO
        </button>

        {/* Dev credentials */}
        <div style={{ padding: '10px 14px', background: 'var(--bg-elevated)', borderRadius: 'var(--radius)', border: '1px solid var(--border)' }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>Identifiants dev</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-code)' }}>admin@local.dev / Admin1234!</div>
        </div>
      </div>
    </div>
  )
}
