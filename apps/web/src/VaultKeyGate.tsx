// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Content of the account's key-management modal (chrome — backdrop, close
// button — owned by AppShell.tsx, same split as SettingsPanel/the Réglages
// modal). Reachable any time via the avatar menu, or contextually by
// clicking a locked vault — never blocks the rest of the UI (see AppShell's
// per-vault lock badges instead of the old full-page gate). A neutral choice
// every time, not just "first login": account creation is admin-only
// (AdminPage.tsx), so the server has no "first time" flag to key off.
// onDone fires once a key is set (entered or generated), letting the caller
// close the modal.
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { useVaultKey } from './VaultKeyContext'
import { bytesToBase64, base64ToBytes, ServerVaultKeyProvider } from '@savoire/infrastructure-sync'

const primaryBtn: CSSProperties = {
  padding: 11, background: 'var(--accent)', color: 'var(--accent-text)', border: 'none',
  borderRadius: 'var(--radius)', fontSize: 14, fontWeight: 600, cursor: 'pointer',
  transition: 'opacity 0.15s, filter 0.12s', letterSpacing: '0.01em', width: '100%', fontFamily: 'var(--font-ui)',
}
const secondaryBtn: CSSProperties = {
  padding: 11, background: 'transparent', color: 'var(--text-muted)', border: '1px solid var(--border)',
  borderRadius: 'var(--radius)', fontSize: 14, fontWeight: 600, cursor: 'pointer', width: '100%', fontFamily: 'var(--font-ui)',
}
const linkBtn: CSSProperties = {
  padding: 4, background: 'transparent', color: 'var(--text-faint)', border: 'none',
  fontSize: 12.5, cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-ui)',
}

function InputField({
  label, value, onChange, placeholder, onEnter, error,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder: string
  onEnter: () => void
  error?: string | null
}) {
  const [focused, setFocused] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyUp={(e: KeyboardEvent) => e.key === 'Enter' && onEnter()}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        spellCheck={false}
        style={{
          padding: '9px 11px',
          background: 'var(--bg-base)',
          color: 'var(--text)',
          border: `1px solid ${error ? 'var(--color-danger)' : focused ? 'var(--accent)' : 'var(--border)'}`,
          borderRadius: 'var(--radius)',
          fontSize: 13,
          outline: 'none',
          boxShadow: focused ? '0 0 0 3px var(--accent-dim)' : 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s',
          fontFamily: 'var(--font-code)',
          width: '100%',
          boxSizing: 'border-box',
        }}
      />
      {error && <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{error}</span>}
    </div>
  )
}

function EnterKey({ userId, onBack, onDone }: { userId: string; onBack: () => void; onDone: () => void }) {
  const { setVaultKey } = useVaultKey()
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  function submit() {
    const trimmed = value.trim()
    let bytes: Uint8Array
    try {
      bytes = base64ToBytes(trimmed)
    } catch {
      setError("Cette clé n'est pas valide (format inattendu).")
      return
    }
    if (bytes.length !== 32) {
      setError("Cette clé n'est pas valide (longueur inattendue).")
      return
    }
    setVaultKey(userId, bytes)
    onDone()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <InputField
        label="Votre clé"
        value={value}
        onChange={v => { setValue(v); setError(null) }}
        placeholder="Collez votre clé ici"
        onEnter={submit}
        error={error}
      />
      <button onClick={submit} disabled={!value.trim()} style={{ ...primaryBtn, opacity: value.trim() ? 1 : 0.45, cursor: value.trim() ? 'pointer' : 'not-allowed' }}>
        Continuer
      </button>
      <button onClick={onBack} style={linkBtn}>← Retour</button>
    </div>
  )
}

function GenerateKey({ userId, onBack, onDone }: { userId: string; onBack: () => void; onDone: () => void }) {
  const { setVaultKey } = useVaultKey()
  const key = useMemo(() => crypto.getRandomValues(new Uint8Array(32)), [])
  const keyBase64 = useMemo(() => bytesToBase64(key), [key])
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(keyBase64).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ padding: '10px 14px', background: 'color-mix(in srgb, var(--color-info) 10%, var(--bg-base))', borderRadius: 'var(--radius)', border: '1px solid color-mix(in srgb, var(--color-info) 30%, var(--border))', color: 'var(--text)', fontSize: 12.5, lineHeight: 1.5 }}>
        Cette clé ne sera plus jamais affichée. Notez-la dans un gestionnaire de mots de passe avant de continuer.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
        <code style={{ flex: 1, padding: '9px 11px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 12.5, fontFamily: 'var(--font-code)', color: 'var(--text)', overflowWrap: 'anywhere', userSelect: 'all' }}>
          {keyBase64}
        </code>
        <button onClick={copy} style={{ ...secondaryBtn, width: 'auto', padding: '0 14px', flexShrink: 0 }}>
          {copied ? 'Copié' : 'Copier'}
        </button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-muted)', cursor: 'pointer' }}>
        <input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} />
        Je l'ai sauvegardée en lieu sûr
      </label>
      <button onClick={() => { setVaultKey(userId, key); onDone() }} disabled={!saved} style={{ ...primaryBtn, opacity: saved ? 1 : 0.45, cursor: saved ? 'pointer' : 'not-allowed' }}>
        Continuer
      </button>
      <button onClick={onBack} style={linkBtn}>← Retour</button>
    </div>
  )
}

// S2 : bascule K_User d'auto-géré (S3, par défaut) à géré-par-le-serveur.
function ServerManaged({ userId, onBack, onDone, getToken }: { userId: string; onBack: () => void; onDone: () => void; getToken: () => string | null }) {
  const { setVaultKey, setServerManaged } = useVaultKey()
  const providerRef = useRef(new ServerVaultKeyProvider({ getToken }))
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function confirm() {
    setLoading(true)
    setError(null)
    try {
      const key = await providerRef.current.fetchOrCreate()
      setVaultKey(userId, key)
      setServerManaged(userId)
      onDone()
    } catch {
      setError('Impossible de récupérer la clé depuis le serveur.')
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ padding: '10px 14px', background: 'color-mix(in srgb, var(--color-danger) 10%, var(--bg-base))', borderRadius: 'var(--radius)', border: '1px solid color-mix(in srgb, var(--color-danger) 30%, var(--border))', color: 'var(--text)', fontSize: 12.5, lineHeight: 1.5 }}>
        Dans ce mode, le serveur génère et conserve votre clé : il peut donc déchiffrer vos vaults.
        En contrepartie, la clé est retrouvée automatiquement à chaque connexion — plus aucun risque de la perdre.
      </div>
      {error && <span style={{ fontSize: 12, color: 'var(--color-danger)' }}>{error}</span>}
      <button onClick={() => void confirm()} disabled={loading} style={{ ...primaryBtn, opacity: loading ? 0.6 : 1, cursor: loading ? 'not-allowed' : 'pointer' }}>
        {loading ? 'Récupération...' : 'Confirmer'}
      </button>
      <button onClick={onBack} style={linkBtn}>← Retour</button>
    </div>
  )
}

export function VaultKeyGate({ userId, onDone, getToken }: { userId: string; onDone: () => void; getToken: () => string | null }) {
  const [mode, setMode] = useState<'choose' | 'enter' | 'generate' | 'server'>('choose')

  return (
    <div style={{ width: 440, padding: 32, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', fontFamily: 'var(--font-ui)' }}>
      <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 6, fontFamily: 'var(--font-editor, var(--font-ui))' }}>
        Clé de coffre
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--text-faint)', lineHeight: 1.5, marginBottom: 24 }}>
        Vos vaults sont chiffrés. Gardez le contrôle total de votre clé (le serveur ne peut alors jamais les lire), ou laissez le serveur la gérer pour plus de confort (il peut alors les déchiffrer).
      </div>

      {mode === 'choose' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button onClick={() => setMode('enter')} style={primaryBtn}>J'ai déjà une clé</button>
          <button onClick={() => setMode('generate')} style={secondaryBtn}>Générer une nouvelle clé</button>
          <button onClick={() => setMode('server')} style={secondaryBtn}>Laisser le serveur gérer ma clé</button>
        </div>
      )}

      {mode === 'enter' && <EnterKey userId={userId} onBack={() => setMode('choose')} onDone={onDone} />}
      {mode === 'generate' && <GenerateKey userId={userId} onBack={() => setMode('choose')} onDone={onDone} />}
      {mode === 'server' && <ServerManaged userId={userId} onBack={() => setMode('choose')} onDone={onDone} getToken={getToken} />}
    </div>
  )
}
