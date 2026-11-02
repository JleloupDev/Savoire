// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Reglage du vault « Pair indexeur » (ADR-027) : qui sert la recherche, les
// bases, les liens et les tags de tout le vault. Gere par Savoire, pair de
// l'organisation (adresse), ou aucun. Modifiable par le proprietaire seul ;
// les autres membres voient le reglage et l'etat du pair.
import { useEffect, useState } from 'react'
import type { IndexerMode, IVaultIndexer, VaultIndexerSetting, VaultIndexerStatus } from '@savoire/application'
import { describeIndicator } from './IndexStatusIndicator'

const MODES: { mode: IndexerMode; label: string; help: string }[] = [
  { mode: 'managed', label: 'Géré par Savoire', help: 'Le pair indexeur du serveur indexe tout le vault : recherche avec extraits, bases, rétroliens et graphe complets.' },
  { mode: 'organization', label: 'Pair de l\'organisation', help: 'Un pair hébergé par votre organisation, avec la clé du vault. Le circuit complet arrive avec le profil chiffré : en attendant, l\'appli garde ses index locaux.' },
  { mode: 'none', label: 'Aucun', help: 'Pas de pair : la recherche se limite aux notes ouvertes, les bases aux notes déjà indexées.' },
]

const box: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10, fontSize: '0.82rem' }
const option: React.CSSProperties = { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--border)' }
const help: React.CSSProperties = { fontSize: '0.72rem', color: 'var(--text-faint)', marginTop: 2, lineHeight: 1.35 }
const input: React.CSSProperties = { marginTop: 6, width: '100%', boxSizing: 'border-box', padding: '4px 8px', background: 'var(--bg-elevated)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, fontSize: '0.8rem' }
const button: React.CSSProperties = { alignSelf: 'flex-start', padding: '5px 12px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.8rem', cursor: 'pointer' }

export function VaultIndexerSettings({ indexer, isOwner, vaultName }: { indexer: IVaultIndexer; isOwner: boolean; vaultName: string }) {
  const [setting, setSetting] = useState<VaultIndexerSetting | null>(null)
  const [mode, setMode] = useState<IndexerMode>('managed')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [status, setStatus] = useState<VaultIndexerStatus>(() => indexer.status())

  useEffect(() => indexer.onStatusChange(setStatus), [indexer])
  useEffect(() => {
    let live = true
    indexer.getSetting().then(s => {
      if (!live) return
      setSetting(s)
      setMode(s.mode)
      setUrl(s.url ?? '')
    }, err => { if (live) setError(err instanceof Error ? err.message : String(err)) })
    return () => { live = false }
  }, [indexer])

  const changed = !!setting && (mode !== setting.mode || (mode === 'organization' && url.trim() !== (setting.url ?? '')))

  async function save() {
    setBusy(true); setError(null); setSaved(false)
    try {
      const s = await indexer.setSetting(mode === 'organization' ? { mode, url: url.trim() } : { mode })
      setSetting(s)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const view = describeIndicator({ source: 'remote', state: status.state, remote: status })
  return (
    <div style={box} data-testid="vault-indexer-settings">
      <div style={{ fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-faint)' }}>
        Pair indexeur — {vaultName}
      </div>
      <div style={help}>
        Le pair indexeur lit tout le vault et répond pour lui : recherche (y compris dans tous vos vaults), bases, rétroliens, graphe, tags.
        L'édition n'en dépend jamais.
      </div>
      {!setting && !error && <div style={help}>Chargement…</div>}
      {setting && MODES.map(m => (
        <label key={m.mode} style={{ ...option, opacity: !isOwner && mode !== m.mode ? 0.6 : 1, cursor: isOwner ? 'pointer' : 'default' }}>
          <input
            type="radio"
            name="vault-indexer-mode"
            data-testid={`vault-indexer-${m.mode}`}
            checked={mode === m.mode}
            disabled={!isOwner || busy}
            onChange={() => { setMode(m.mode); setSaved(false) }}
          />
          <div style={{ flex: 1 }}>
            <div>{m.label}</div>
            <div style={help}>{m.help}</div>
            {m.mode === 'organization' && mode === 'organization' && (
              <input
                style={input}
                data-testid="vault-indexer-url"
                placeholder="https://indexeur.exemple.org"
                value={url}
                disabled={!isOwner || busy}
                onChange={e => { setUrl(e.target.value); setSaved(false) }}
              />
            )}
          </div>
        </label>
      ))}
      {setting && isOwner && (
        <button style={{ ...button, opacity: changed && !busy ? 1 : 0.5 }} disabled={!changed || busy} data-testid="vault-indexer-save" onClick={() => void save()}>
          {busy ? 'Enregistrement…' : 'Enregistrer'}
        </button>
      )}
      {setting && !isOwner && <div style={help}>Seul le propriétaire du vault peut changer ce réglage.</div>}
      {saved && <div style={{ ...help, color: 'var(--color-success)' }}>Réglage enregistré.</div>}
      {error && <div style={{ ...help, color: 'var(--color-danger)' }} data-testid="vault-indexer-error">{error}</div>}
      {view && (
        <div style={{ ...help, display: 'flex', gap: 6, alignItems: 'center' }} data-testid="vault-indexer-state" title={view.title}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: view.color }} />
          <span>État : {view.label}{status.docs !== undefined ? ` · ${status.docs} notes indexées` : ''}</span>
        </div>
      )}
    </div>
  )
}
