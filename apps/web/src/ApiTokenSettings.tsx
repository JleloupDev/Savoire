// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Parametres → API : les jetons personnels de l'API ouverte. Un jeton laisse
// ChatGPT, Claude, un script ou n8n lire vos notes en votre nom (lecture
// seule), sur tous vos vaults ou ceux choisis. Montre une seule fois.
import { useEffect, useState } from 'react'
import { serverUrl } from '@savoire/infrastructure-sync'

const INPUT: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', font: 'inherit', fontSize: 12,
}
const BTN: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff', fontWeight: 600 }
const CODE: React.CSSProperties = {
  fontFamily: 'var(--font-mono, monospace)', fontSize: 11, padding: '6px 8px', borderRadius: 6,
  background: 'var(--bg-elevated)', border: '1px solid var(--border)', wordBreak: 'break-all', userSelect: 'all',
}

interface AccessToken {
  id: string
  name: string
  prefix: string
  vaultIds: string[] | null
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revoked: boolean
}

interface Draft { name: string; all: boolean; vaultIds: string[]; days: string }

export function ApiTokenSettings({ token, vaults }: { token: () => string; vaults: { id: string; name: string }[] }) {
  const [list, setList] = useState<AccessToken[] | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [created, setCreated] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await fetch(serverUrl(`/api/v1/me/access-tokens${path}`), {
      method,
      headers: { Authorization: `Bearer ${token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) {
      const problem = await res.json().catch(() => null) as { detail?: string; errors?: Record<string, string[]>; title?: string } | null
      const first = problem?.errors ? Object.values(problem.errors).flat()[0] : undefined
      throw new Error(first ?? problem?.detail ?? problem?.title ?? `Erreur ${res.status}`)
    }
    return res
  }

  const reload = () => call('GET', '').then(r => r.json()).then(setList, err => setError(String(err.message ?? err)))
  useEffect(() => { void reload() }, [])

  const create = async () => {
    if (!draft) return
    setBusy(true); setError(null)
    try {
      const days = Number(draft.days)
      const res = await call('POST', '', {
        name: draft.name.trim(),
        vaultIds: draft.all ? null : draft.vaultIds,
        expiresInDays: draft.days && days > 0 ? days : null,
      })
      const body = await res.json() as { token: string }
      setCreated(body.token)
      setDraft(null)
      await reload()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (t: AccessToken) => {
    if (!window.confirm(`Révoquer « ${t.name} » ? Ce qui l’utilise n’aura plus accès.`)) return
    try { await call('DELETE', `/${encodeURIComponent(t.id)}`); await reload() } catch (err) { setError((err as Error).message) }
  }

  const mcpUrl = new URL(serverUrl('/api/mcp'), window.location.href).toString()
  const restUrl = new URL(serverUrl('/api/open/v1'), window.location.href).toString()
  const vaultName = (id: string) => vaults.find(v => v.id === id)?.name ?? id
  const active = (list ?? []).filter(t => !t.revoked && !(t.expiresAt && new Date(t.expiresAt) < new Date()))

  return (
    <div data-testid="api-settings" style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 12 }}>
      <div style={{ color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Un jeton laisse un outil externe (ChatGPT, Claude, un script, n8n…) <strong>lire</strong> vos notes en votre nom :
        chercher, lister, lire. Il n’ouvre que les vaults choisis et se révoque à tout moment.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', alignItems: 'center' }}>
        <span style={{ color: 'var(--text-muted)' }}>Serveur MCP</span>
        <code data-testid="api-mcp-url" style={CODE}>{mcpUrl}</code>
        <span style={{ color: 'var(--text-muted)' }}>API REST</span>
        <code style={CODE}>{restUrl}</code>
      </div>

      {created && (
        <div data-testid="api-token-created" style={{ padding: 10, borderRadius: 8, border: '1px solid var(--accent)', display: 'flex', flexDirection: 'column', gap: 6 }}>
          <strong>Votre jeton : copiez-le maintenant, il ne sera plus affiché.</strong>
          <code data-testid="api-token-value" style={CODE}>{created}</code>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={PRIMARY} onClick={() => { void navigator.clipboard?.writeText(created) }}>Copier</button>
            <button style={BTN} onClick={() => setCreated(null)}>J’ai copié</button>
          </div>
          <span style={{ color: 'var(--text-muted)' }}>À donner comme en-tête : <code>Authorization: Bearer {created.slice(0, 10)}…</code></span>
        </div>
      )}

      {error && <div role="alert" style={{ color: 'var(--danger, #dc2626)' }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {list === null && <span style={{ color: 'var(--text-muted)' }}>Chargement…</span>}
        {list !== null && active.length === 0 && <span style={{ color: 'var(--text-muted)' }}>Aucun jeton actif.</span>}
        {active.map(t => (
          <div key={t.id} data-testid="api-token-row" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600 }}>{t.name} <code style={{ fontWeight: 400, color: 'var(--text-muted)' }}>{t.prefix}…</code></div>
              <div style={{ color: 'var(--text-muted)' }}>
                {t.vaultIds ? t.vaultIds.map(vaultName).join(', ') : 'Tous vos vaults'} · lecture
                {' · '}{t.lastUsedAt ? `utilisé le ${new Date(t.lastUsedAt).toLocaleDateString()}` : 'jamais utilisé'}
                {t.expiresAt ? ` · expire le ${new Date(t.expiresAt).toLocaleDateString()}` : ''}
              </div>
            </div>
            <button data-testid="api-token-revoke" style={BTN} onClick={() => void revoke(t)}>Révoquer</button>
          </div>
        ))}
      </div>

      {draft ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRadius: 8, border: '1px solid var(--border)' }}>
          <label>Nom<input data-testid="api-token-name" style={INPUT} value={draft.name} placeholder="Claude, n8n, script…" onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={draft.all} onChange={e => setDraft({ ...draft, all: e.target.checked })} /> Tous mes vaults
          </label>
          {!draft.all && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 120, overflow: 'auto' }}>
              {vaults.map(v => (
                <label key={v.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="checkbox" checked={draft.vaultIds.includes(v.id)}
                    onChange={e => setDraft({ ...draft, vaultIds: e.target.checked ? [...draft.vaultIds, v.id] : draft.vaultIds.filter(x => x !== v.id) })} />
                  {v.name}
                </label>
              ))}
            </div>
          )}
          <label>Expire dans (jours, vide : jamais)<input style={INPUT} inputMode="numeric" value={draft.days} onChange={e => setDraft({ ...draft, days: e.target.value.replace(/\D/g, '') })} /></label>
          <div style={{ display: 'flex', gap: 6 }}>
            <button data-testid="api-token-create" style={PRIMARY} disabled={busy || !draft.name.trim() || (!draft.all && draft.vaultIds.length === 0)} onClick={() => void create()}>Créer le jeton</button>
            <button style={BTN} onClick={() => setDraft(null)}>Annuler</button>
          </div>
        </div>
      ) : (
        <button data-testid="api-token-new" style={{ ...BTN, alignSelf: 'flex-start' }} onClick={() => { setCreated(null); setDraft({ name: '', all: true, vaultIds: [], days: '90' }) }}>+ Nouveau jeton</button>
      )}
    </div>
  )
}
