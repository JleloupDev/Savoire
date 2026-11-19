// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecran d'accord OAuth (ADR-033) : ChatGPT ou Claude.ai demande l'acces au
// MCP de Savoire. La personne, connectee comme dans l'appli, choisit l'agent
// que portera l'IA (ses droits, son nom) et les vaults ouverts, puis accepte
// ou refuse. Le serveur rend l'adresse ou renvoyer le client.
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { serverUrl } from '@savoire/infrastructure-sync'
import { useAuth } from './AuthContext'

/** Ou revenir apres la connexion (lu par LoginPage). */
export const RETURN_TO_KEY = 'savoire.returnTo'

interface RequestInfo {
  clientName: string
  clientId: string
  redirectHost: string
  vaults: { id: string; name: string }[]
  agents: { id: string; name: string; vaultId: string | null }[]
}

const BOX: React.CSSProperties = {
  maxWidth: 480, margin: '60px auto', padding: 24, borderRadius: 12, border: '1px solid var(--border)',
  background: 'var(--bg-surface, var(--bg-base))', color: 'var(--text)', fontFamily: 'var(--font-ui)', fontSize: 13,
  display: 'flex', flexDirection: 'column', gap: 14,
}
const INPUT: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', font: 'inherit',
}
const BTN: React.CSSProperties = {
  padding: '6px 14px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', font: 'inherit', cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff', fontWeight: 600 }

export function OAuthConsentPage() {
  const { token, isReady } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const request = params.get('request') ?? ''
  const [info, setInfo] = useState<RequestInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agentId, setAgentId] = useState('')
  const [all, setAll] = useState(true)
  const [vaultIds, setVaultIds] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  // Pas connecte : la connexion d'abord, puis retour ici.
  useEffect(() => {
    if (!isReady || token) return
    try { sessionStorage.setItem(RETURN_TO_KEY, `${location.pathname}${location.search}`) } catch { /* stockage indisponible */ }
    navigate('/login', { replace: true })
  }, [isReady, token, navigate])

  useEffect(() => {
    if (!token || !request) return
    fetch(serverUrl(`/api/v1/oauth/requests/${encodeURIComponent(request)}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async r => {
        if (r.status === 404) throw new Error('Cette demande a expiré ou a déjà servi. Relancez la connexion depuis l’outil.')
        if (!r.ok) throw new Error(`Erreur ${r.status}`)
        return r.json() as Promise<RequestInfo>
      })
      .then(setInfo, err => setError((err as Error).message))
  }, [token, request])

  const decide = async (approve: boolean) => {
    if (!token) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(serverUrl(`/api/v1/oauth/requests/${encodeURIComponent(request)}/decide`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve, agentId: agentId || null, vaultIds: all ? null : vaultIds }),
      })
      const body = await res.json().catch(() => null) as { redirect?: string; detail?: string; errors?: Record<string, string[]> } | null
      if (!res.ok || !body?.redirect) {
        const first = body?.errors ? Object.values(body.errors).flat()[0] : undefined
        throw new Error(first ?? body?.detail ?? `Erreur ${res.status}`)
      }
      window.location.assign(body.redirect)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  if (!request) return <div style={BOX}>Demande d’accès manquante.</div>
  if (!token) return <div style={BOX}>Connexion…</div>

  return (
    <div data-testid="oauth-consent" style={BOX}>
      <h2 style={{ margin: 0, fontSize: 18 }}>Autoriser l’accès à Savoire</h2>
      {error && <div role="alert" style={{ color: 'var(--danger, #dc2626)' }}>{error}</div>}
      {!info && !error && <span style={{ color: 'var(--text-muted)' }}>Chargement…</span>}
      {info && (
        <>
          <div style={{ lineHeight: 1.5 }}>
            <strong>{info.clientName}</strong> demande à utiliser vos notes par le serveur MCP de Savoire.
            Il reviendra sur <code>{info.redirectHost}</code>.
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            Agent porté par l’outil
            <select data-testid="oauth-agent" style={INPUT} value={agentId} onChange={e => setAgentId(e.target.value)}>
              <option value="">Aucun : lecture seule</option>
              {info.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>L’outil aura les droits de cet agent et signera de son nom (Paramètres → Agents).</span>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> Tous mes vaults
          </label>
          {!all && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 160, overflow: 'auto' }}>
              {info.vaults.map(v => (
                <label key={v.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={vaultIds.includes(v.id)}
                    onChange={e => setVaultIds(e.target.checked ? [...vaultIds, v.id] : vaultIds.filter(x => x !== v.id))} />
                  {v.name}
                </label>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button data-testid="oauth-approve" style={PRIMARY} disabled={busy || (!all && vaultIds.length === 0)} onClick={() => void decide(true)}>Autoriser</button>
            <button data-testid="oauth-deny" style={BTN} disabled={busy} onClick={() => void decide(false)}>Refuser</button>
          </div>
          <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Révocable à tout moment dans Paramètres → API.</span>
        </>
      )}
    </div>
  )
}
