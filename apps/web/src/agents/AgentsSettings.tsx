// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Parametres → Agents (ADR-033) : declarer des agents. Un agent est une
// identite : un nom, des consignes (un simple prompt), ce qu'il a le droit de
// faire action par action, ou, et avec quel budget. Il se cree a la main ou a
// partir d'un modele apporte par un plugin du store.
import { useEffect, useState } from 'react'
import { ACTION_LABELS, MODE_LABELS, normalizePermissions } from '@savoire/agent-core'
import { AGENT_ACTION_MODES, AGENT_ACTIONS, type AgentActionMode, type AgentDefinition, type AgentPreset } from '@savoire/plugin-api'
import type { AIConnectionInfo } from '@savoire/plugin-api'
import { agentDirectory, notifyAgentsChanged, onAgentDirectoryChange, type AgentDraft } from './agentDirectory'

const INPUT: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', font: 'inherit', fontSize: 12,
}
const BTN: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff', fontWeight: 600 }
const MUTED: React.CSSProperties = { color: 'var(--text-muted)', fontSize: 12 }
const LABEL: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, margin: '10px 0 4px' }

export interface AgentsSettingsProps {
  presets: { preset: AgentPreset; pluginId: string }[]
  connections: AIConnectionInfo[]
  /** Vaults ou l'on peut creer un agent du vault (administrateur). */
  adminVaults: { id: string; name: string }[]
  vaults: { id: string; name: string }[]
}

function blank(): AgentDraft {
  return { name: '', description: '', instructions: '', permissions: { read: 'direct', comment: 'ask', edit: 'propose' }, source: { kind: 'manual' } }
}

function fromPreset(p: AgentPreset, pluginId: string): AgentDraft {
  return {
    name: p.name, description: p.description, instructions: p.instructions, permissions: { ...p.permissions },
    ...(p.budget ? { budget: { ...p.budget } } : {}), source: { kind: 'preset', pluginId, presetId: p.id },
  }
}

export function AgentsSettings({ presets, connections, adminVaults, vaults }: AgentsSettingsProps) {
  const [list, setList] = useState<AgentDefinition[] | null>(null)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dir = agentDirectory()

  const reload = () => {
    const d = agentDirectory()
    if (!d) { setList([]); return }
    d.list().then(setList, err => setError(String((err as Error).message ?? err)))
  }
  useEffect(() => { reload(); return onAgentDirectoryChange(reload) }, [])

  const save = async () => {
    if (!draft || !dir) return
    setBusy(true); setError(null)
    try {
      if (!draft.name.trim()) throw new Error('Donnez un nom à l’agent.')
      await dir.save({ ...draft, name: draft.name.trim(), permissions: normalizePermissions(draft.permissions) })
      setDraft(null)
      notifyAgentsChanged()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (a: AgentDefinition) => {
    if (!dir || !window.confirm(`Supprimer l’agent « ${a.name} » ? Ce qu’il a déjà fait reste signé de son nom.`)) return
    try { await dir.remove(a.id); notifyAgentsChanged() } catch (err) { setError((err as Error).message) }
  }

  if (!dir) return <div style={{ padding: 24, ...MUTED }}>Connectez-vous pour déclarer des agents.</div>

  if (draft) {
    const perms = normalizePermissions(draft.permissions)
    const set = (patch: Partial<AgentDraft>) => setDraft({ ...draft, ...patch })
    return (
      <div data-testid="agent-form" style={{ padding: '16px 24px', overflowY: 'auto' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{draft.id ? 'Modifier l’agent' : 'Nouvel agent'}</div>
        <label style={LABEL}>Nom</label>
        <input data-testid="agent-name" style={INPUT} value={draft.name} onChange={e => set({ name: e.target.value })} placeholder="Archiviste" />
        <label style={LABEL}>Description</label>
        <input style={INPUT} value={draft.description} onChange={e => set({ description: e.target.value })} placeholder="Range les notes de l’Inbox" />
        <label style={LABEL}>Consignes (prompt)</label>
        <textarea data-testid="agent-instructions" style={{ ...INPUT, minHeight: 110, resize: 'vertical' }} value={draft.instructions}
          onChange={e => set({ instructions: e.target.value })} placeholder="Tu ranges les notes du dossier Inbox dans les bons dossiers…" />

        <label style={LABEL}>Appartient à</label>
        <select style={INPUT} value={draft.vaultId ?? ''} onChange={e => set({ vaultId: e.target.value || undefined })}>
          <option value="">Moi (agent personnel)</option>
          {adminVaults.map(v => <option key={v.id} value={v.id}>Vault « {v.name} » (partagé avec ses membres)</option>)}
        </select>

        <label style={LABEL}>Ce qu’il peut faire</label>
        <div style={MUTED}>Il n’a jamais plus de droits que la personne pour qui il agit.</div>
        <table style={{ width: '100%', marginTop: 6, fontSize: 12, borderCollapse: 'collapse' }}>
          <tbody>
            {AGENT_ACTIONS.map(a => (
              <tr key={a}>
                <td style={{ padding: '3px 0' }}>{ACTION_LABELS[a]}</td>
                <td style={{ width: 190 }}>
                  <select data-testid={`agent-perm-${a}`} style={INPUT} value={perms[a]}
                    onChange={e => set({ permissions: { ...perms, [a]: e.target.value as AgentActionMode } })}>
                    {AGENT_ACTION_MODES[a].map(m => <option key={m} value={m}>{MODE_LABELS[m]}</option>)}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {perms.delegate !== 'deny' && (
          <>
            <label style={LABEL}>Sous-agents</label>
            <div style={MUTED}>Ceux à qui il peut confier une tâche. Ils n’ont jamais plus de droits que lui ; trois niveaux au plus.</div>
            {(list ?? []).filter(a => a.id !== draft.id).length === 0 && <div style={{ ...MUTED, marginTop: 4 }}>Aucun autre agent pour l’instant.</div>}
            {(list ?? []).filter(a => a.id !== draft.id).map(a => (
              <label key={a.id} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, marginTop: 4 }}>
                <input type="checkbox" data-testid={`agent-delegate-${a.id}`} checked={draft.delegates?.includes(a.id) ?? false}
                  onChange={e => {
                    const rest = (draft.delegates ?? []).filter(id => id !== a.id)
                    set({ delegates: e.target.checked ? [...rest, a.id] : rest })
                  }} />
                {a.name}{a.description ? <span style={MUTED}> · {a.description}</span> : null}
              </label>
            ))}
          </>
        )}

        <label style={LABEL}>Où</label>
        <select style={INPUT} value={draft.scope?.vaultIds?.[0] ?? ''}
          onChange={e => set({ scope: { ...draft.scope, vaultIds: e.target.value ? [e.target.value] : [] } })}>
          <option value="">Tous les vaults</option>
          {vaults.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <input style={{ ...INPUT, marginTop: 6 }} placeholder="Dossiers permis, séparés par des virgules (vide : tous)"
          value={(draft.scope?.folders ?? []).join(', ')}
          onChange={e => set({ scope: { ...draft.scope, folders: e.target.value.split(',').map(f => f.trim()).filter(Boolean) } })} />

        <label style={LABEL}>IA utilisée dans l’appli</label>
        <select style={INPUT} value={draft.connectionId ?? ''} onChange={e => set({ connectionId: e.target.value || undefined })}>
          <option value="">Connexion par défaut</option>
          {connections.map(c => <option key={c.id} value={c.id}>{c.name} ({c.model || 'modèle à choisir'})</option>)}
        </select>
        <input style={{ ...INPUT, marginTop: 6 }} placeholder="Modèle (facultatif, sinon celui de la connexion)" value={draft.model ?? ''}
          onChange={e => set({ model: e.target.value.trim() || undefined })} />
        <div style={MUTED}>Depuis ChatGPT ou Claude, c’est leur IA qui porte l’agent : rattachez-lui un jeton (Paramètres → API).</div>

        <label style={LABEL}>Budget</label>
        <div style={{ display: 'flex', gap: 6 }}>
          {([['maxSteps', 'Étapes / exécution'], ['maxTokensPerRun', 'Tokens / exécution'], ['maxTokensPerDay', 'Tokens / jour'], ...(perms.delegate !== 'deny' ? [['maxTokensPerChild', 'Tokens / sous-agent']] as const : [])] as const).map(([k, label]) => (
            <input key={k} style={INPUT} type="number" min={0} placeholder={label} title={label} value={draft.budget?.[k] ?? ''}
              onChange={e => set({ budget: { ...draft.budget, [k]: e.target.value ? Math.max(0, Number(e.target.value)) : undefined } })} />
          ))}
        </div>

        {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 12, marginTop: 8 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button data-testid="agent-save" style={PRIMARY} disabled={busy} onClick={() => void save()}>Enregistrer</button>
          <button style={BTN} onClick={() => { setDraft(null); setError(null) }}>Annuler</button>
        </div>
      </div>
    )
  }

  return (
    <div data-testid="agents-settings" style={{ padding: '16px 24px', overflowY: 'auto' }}>
      <div style={MUTED}>
        Un agent est une identité : un nom, des consignes et des droits. Une IA (la vôtre dans l’appli, ou ChatGPT par l’API) le porte.
        Ce qu’il fait est signé de son nom : « Archiviste (IA), pour vous ».{dir.kind === 'local' ? ' Profil local : les agents restent sur ce poste.' : ''}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button data-testid="agent-new" style={PRIMARY} onClick={() => setDraft(blank())}>Nouvel agent</button>
        {presets.map(({ preset, pluginId }) => (
          <button key={`${pluginId}:${preset.id}`} style={BTN} title={preset.description} onClick={() => setDraft(fromPreset(preset, pluginId))}>
            À partir de « {preset.name} »
          </button>
        ))}
      </div>
      {presets.length === 0 && <div style={{ ...MUTED, marginTop: 6 }}>Des modèles d’agents s’installent depuis le store (ex. Agent Correcteur).</div>}
      {error && <div style={{ color: 'var(--danger, #ef4444)', fontSize: 12, marginTop: 8 }}>{error}</div>}
      <div style={{ marginTop: 14 }}>
        {list === null && <div style={MUTED}>Chargement…</div>}
        {list?.length === 0 && <div style={MUTED}>Aucun agent pour l’instant.</div>}
        {list?.map(a => {
          const perms = normalizePermissions(a.permissions)
          const rights = AGENT_ACTIONS.filter(x => perms[x] !== 'deny').map(x => `${ACTION_LABELS[x]} (${MODE_LABELS[perms[x]].toLowerCase()})`).join(', ')
          const subs = perms.delegate !== 'deny' ? (a.delegates ?? []).map(id => list.find(b => b.id === id)?.name).filter(Boolean).join(', ') : ''
          return (
            <div key={a.id} data-testid="agent-row" style={{ display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{a.name}{a.vaultId ? <span style={MUTED}> · agent du vault</span> : null}</div>
                {a.description && <div style={MUTED}>{a.description}</div>}
                <div style={{ ...MUTED, marginTop: 2 }}>{rights || 'Aucun droit'}</div>
                {subs && <div style={{ ...MUTED, marginTop: 2 }}>Sous-agents : {subs}</div>}
              </div>
              <button style={BTN} onClick={() => setDraft({ ...a })}>Modifier</button>
              <button style={BTN} onClick={() => void remove(a)}>Supprimer</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
