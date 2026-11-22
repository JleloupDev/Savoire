// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecran d'accord OAuth (ADR-033) : ChatGPT ou Claude.ai demande l'acces au
// MCP de Savoire. La personne, connectee comme dans l'appli, choisit l'agent
// que portera l'IA (ses droits, son nom) et les vaults ouverts, puis accepte
// ou refuse. Le serveur rend l'adresse ou renvoyer le client.
// Pas encore d'agent qui convienne : on en cree un ici, en choisissant ses
// droits parmi quelques reglages simples (le detail reste dans Parametres).
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
/** Option du choix d'agent : en creer un. */
const NEW_AGENT = '__new'

/** Reglages simples des droits d'un agent cree ici (modes valides : AGENT_ACTION_MODES). */
const PRESETS = [
  { id: 'ask', label: 'Lire, et écrire en me demandant', hint: 'Chaque changement attend votre accord dans Savoire (Agents > Activité).',
    permissions: { read: 'direct', comment: 'direct', edit: 'ask', create: 'ask', organize: 'ask', delete: 'ask' } },
  { id: 'direct', label: 'Lire et écrire directement', hint: 'Modifier, créer, ranger, ajouter des images. Mettre à la corbeille demande votre accord.',
    permissions: { read: 'direct', comment: 'direct', edit: 'direct', create: 'direct', organize: 'direct', delete: 'ask' } },
  { id: 'propose', label: 'Lire et proposer', hint: 'Les changements deviennent des propositions dans la Révision : rien ne change sans vous.',
    permissions: { read: 'direct', comment: 'direct', edit: 'propose' } },
  { id: 'read', label: 'Lire seulement', hint: 'Chercher et lire vos notes, rien d’autre.',
    permissions: { read: 'direct' } },
] as const

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
  const [newName, setNewName] = useState('')
  const [preset, setPreset] = useState<(typeof PRESETS)[number]['id']>('ask')
  // Agent deja cree par un essai precedent (on ne le recree pas si l'accord echoue).
  const [createdId, setCreatedId] = useState<string | null>(null)

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
      .then(i => {
        setInfo(i)
        setNewName(i.clientName || 'Assistant')
        // Aucun agent : on propose d'en creer un.
        if (i.agents.length === 0) setAgentId(NEW_AGENT)
      }, err => setError((err as Error).message))
  }, [token, request])

  const decide = async (approve: boolean) => {
    if (!token) return
    setBusy(true); setError(null)
    try {
      let chosen = agentId
      if (approve && agentId === NEW_AGENT) chosen = createdId ?? await createAgent()
      const res = await fetch(serverUrl(`/api/v1/oauth/requests/${encodeURIComponent(request)}/decide`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve, agentId: (chosen === NEW_AGENT ? '' : chosen) || null, vaultIds: all ? null : vaultIds }),
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

  const createAgent = async (): Promise<string> => {
    const name = newName.trim()
    if (!name) throw new Error('Donnez un nom à l’agent.')
    const res = await fetch(serverUrl('/api/v1/agents'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, instructions: '', permissions: PRESETS.find(p => p.id === preset)!.permissions }),
    })
    const body = await res.json().catch(() => null) as { id?: string; detail?: string } | null
    if (!res.ok || !body?.id) throw new Error(body?.detail ?? `Création de l’agent : erreur ${res.status}`)
    setCreatedId(body.id)
    return body.id
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
              <option value={NEW_AGENT}>+ Créer un agent…</option>
            </select>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>L’outil aura les droits de cet agent et signera de son nom (Paramètres → Agents).</span>
          </label>
          {agentId === NEW_AGENT && (
            <div data-testid="oauth-new-agent" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, borderRadius: 8, border: '1px solid var(--border)' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                Nom de l’agent
                <input data-testid="oauth-new-agent-name" style={INPUT} value={newName} maxLength={80} disabled={!!createdId} onChange={e => setNewName(e.target.value)} />
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {PRESETS.map(p => (
                  <label key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                    <input type="radio" name="oauth-preset" value={p.id} checked={preset === p.id} disabled={!!createdId} onChange={() => setPreset(p.id)} style={{ marginTop: 2 }} />
                    <span>{p.label}<br /><span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{p.hint}</span></span>
                  </label>
                ))}
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Ses droits se changent ensuite dans Paramètres → Agents.</span>
            </div>
          )}
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
