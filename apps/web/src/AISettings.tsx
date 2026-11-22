// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Parametres → IA : les connexions de la personne a des services d'IA.
// La cle reste dans l'application (ce poste) ; les plugins ne la voient pas.
import { useEffect, useState } from 'react'
import type { AIConnection, AIService } from '@savoire/application'
import { DEFAULT_TRANSCRIPTION_MODEL, browserDictationAvailable, dictationSourceLabel, loadDictationSettings, saveDictationSettings, type DictationSettings } from './dictation'

const INPUT: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6,
  border: '1px solid var(--border)', background: 'var(--bg-elevated)', color: 'var(--text)', font: 'inherit', fontSize: 12,
}
const BTN: React.CSSProperties = {
  padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', font: 'inherit', fontSize: 12, cursor: 'pointer',
}
const PRIMARY: React.CSSProperties = { ...BTN, background: 'var(--accent)', border: '1px solid var(--accent)', color: '#fff', fontWeight: 600 }

interface Draft { id?: string; providerId: string; name: string; baseUrl: string; apiKey: string; model: string }

export function AISettings({ ai }: { ai: AIService }) {
  const [, setTick] = useState(0)
  useEffect(() => ai.onChange(() => setTick(t => t + 1)), [ai])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const providers = ai.listProviders()
  const connections = ai.connections()

  const startNew = () => {
    const p = providers[0]
    setDraft({ providerId: p.id, name: p.name, baseUrl: p.baseUrl, apiKey: '', model: p.models?.[0] ?? '' })
    setModels(providers[0].models ?? []); setStatus(null)
  }
  const edit = (c: AIConnection) => { setDraft({ ...c }); setModels([]); setStatus(null) }
  const pickProvider = (id: string) => {
    const p = ai.provider(id)!
    setDraft(d => d && ({ ...d, providerId: id, name: p.name, baseUrl: p.baseUrl, model: p.models?.[0] ?? '' }))
    setModels(p.models ?? [])
  }
  const run = async (job: () => Promise<string>) => {
    setBusy(true); setStatus(null)
    try { setStatus({ ok: true, text: await job() }) } catch (err) { setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) }) }
    setBusy(false)
  }
  const provider = draft ? ai.provider(draft.providerId) : undefined

  return (
    <div data-testid="ai-settings" style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 620 }}>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
        Branchez vos services d’IA. Les agents et les plugins s’en servent avec vos droits.
        Vos clés restent sur ce poste, dans Savoire : aucun plugin ne les voit.
      </div>

      {connections.length === 0 && !draft && <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Aucune connexion.</div>}
      {connections.map(c => (
        <div key={c.id} data-testid="ai-connection" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}>
          <input type="radio" name="ai-default" checked={c.isDefault} title="Connexion par défaut" onChange={() => ai.setDefault(c.id)} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{c.name}{c.isDefault && <span style={{ fontWeight: 400, color: 'var(--text-faint)' }}> · par défaut</span>}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {ai.provider(c.providerId)?.name ?? c.providerId} · {c.model || 'modèle à choisir'} · {c.baseUrl}
            </div>
          </div>
          <button style={BTN} onClick={() => edit(c)}>Modifier</button>
          <button style={BTN} data-testid="ai-remove" onClick={() => ai.removeConnection(c.id)}>Retirer</button>
        </div>
      ))}

      {!draft && <div><button style={PRIMARY} data-testid="ai-add" onClick={startNew}>Ajouter une connexion</button></div>}

      {draft && (
        <div data-testid="ai-form" style={{ display: 'grid', gridTemplateColumns: '130px 1fr', gap: '8px 10px', alignItems: 'center', padding: 12, border: '1px solid var(--border)', borderRadius: 8 }}>
          <label>Service</label>
          <select data-testid="ai-provider" style={INPUT} value={draft.providerId} onChange={e => pickProvider(e.target.value)}>
            {providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {provider?.description && <><span /><div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{provider.description}</div></>}
          <label>Nom</label>
          <input data-testid="ai-name" style={INPUT} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <label>Adresse</label>
          <input data-testid="ai-url" style={INPUT} value={draft.baseUrl} placeholder="https://…/v1" onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} />
          <label>Clé API</label>
          <div>
            <input data-testid="ai-key" style={INPUT} type="password" autoComplete="off" value={draft.apiKey}
              placeholder={provider?.requiresKey === false ? 'Pas de clé pour un service local' : 'sk-…'}
              onChange={e => setDraft({ ...draft, apiKey: e.target.value })} />
            {provider?.keyUrl && <a href={provider.keyUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11 }}>Obtenir une clé</a>}
          </div>
          <label>Modèle</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input data-testid="ai-model" style={INPUT} list="ai-models" value={draft.model} onChange={e => setDraft({ ...draft, model: e.target.value })} />
            <datalist id="ai-models">{models.map(m => <option key={m} value={m} />)}</datalist>
            <button style={{ ...BTN, whiteSpace: 'nowrap' }} disabled={busy} data-testid="ai-list-models"
              onClick={() => void run(async () => { const list = await ai.listModels(draft); setModels(list); if (!draft.model && list[0]) setDraft({ ...draft, model: list[0] }); return `${list.length} modèle(s) trouvés.` })}>
              Lister
            </button>
          </div>
          <span />
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={PRIMARY} data-testid="ai-save" disabled={busy} onClick={() => {
              try { const saved = ai.saveConnection(draft); setDraft(null); setStatus({ ok: true, text: `« ${saved.name} » enregistrée.` }) }
              catch (err) { setStatus({ ok: false, text: err instanceof Error ? err.message : String(err) }) }
            }}>Enregistrer</button>
            <button style={BTN} data-testid="ai-test" disabled={busy} onClick={() => void run(async () => {
              const saved = ai.saveConnection(draft)
              setDraft({ ...draft, id: saved.id })
              const r = await ai.chat({ messages: [{ role: 'user', content: 'Réponds seulement : OK' }], maxTokens: 10 }, saved.id)
              return `Réponse de ${r.model} : « ${r.text.trim().slice(0, 80)} »`
            })}>Tester</button>
            <button style={BTN} onClick={() => { setDraft(null); setStatus(null) }}>Annuler</button>
          </div>
        </div>
      )}
      {status && <div data-testid="ai-status" style={{ fontSize: 12, color: status.ok ? 'var(--green, #16a34a)' : 'var(--danger, #dc2626)' }}>{status.text}</div>}
      <DictationSection connections={connections} />
    </div>
  )
}

/** Dictee : d'ou vient le texte dicte (bouton micro de la barre de l'editeur). */
function DictationSection({ connections }: { connections: AIConnection[] }) {
  const [s, setS] = useState<DictationSettings>(() => loadDictationSettings())
  const browser = browserDictationAvailable()
  const update = (patch: Partial<DictationSettings>) => { const next = { ...s, ...patch }; setS(next); saveDictationSettings(next) }
  // Une connexion choisie puis supprimee : c'est celle par defaut qui sert.
  const chosen = s.connectionId && connections.some(c => c.id === s.connectionId) ? s.connectionId : ''
  const fallback = connections.find(c => c.isDefault) ?? connections[0]
  const value = s.source === 'browser' ? 'browser' : `c:${chosen}`
  return (
    <div data-testid="dictation-settings" style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
      <div style={{ fontWeight: 600, fontSize: 13 }}>Dictée</div>
      <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
        Le bouton micro de la barre de l’éditeur écrit ce que vous dites, au curseur. Choisissez qui transcrit.
      </div>
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        Source
        <select data-testid="dictation-source" style={INPUT} value={value}
          onChange={e => update(e.target.value === 'browser' ? { source: 'browser' } : { source: 'connection', connectionId: e.target.value.slice(2) || undefined })}>
          <option value="browser" disabled={!browser}>Navigateur (sans clé){browser ? '' : ' — indisponible ici'}</option>
          {connections.length > 0 && <option value="c:">Connexion par défaut ({fallback?.name})</option>}
          {connections.map(c => <option key={c.id} value={`c:${c.id}`}>Connexion : {c.name}</option>)}
        </select>
      </label>
      <div data-testid="dictation-current" style={{ fontSize: 12 }}>
        Utilisée en ce moment : <b>{dictationSourceLabel(s)}</b>
      </div>
      {s.source === 'browser' && (
        <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Le texte arrive phrase par phrase. Le navigateur peut envoyer le son à son éditeur (Google, Apple, Microsoft).</div>
      )}
      {s.source === 'connection' && (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            Modèle de transcription
            <input data-testid="dictation-model" style={INPUT} value={s.model} placeholder={DEFAULT_TRANSCRIPTION_MODEL} onChange={e => update({ model: e.target.value })} />
          </label>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5 }}>
            OpenAI : gpt-4o-mini-transcribe ou whisper-1. Sur ce poste : un service compatible OpenAI (whisper.cpp, Speaches), avec son nom de modèle ; rien ne quitte alors l’ordinateur.
            Le texte arrive à chaque pause, pendant que vous parlez (10 minutes au plus par dictée).
          </div>
        </>
      )}
      <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, maxWidth: 160 }}>
        Langue
        <input data-testid="dictation-language" style={INPUT} value={s.language} placeholder="fr" onChange={e => update({ language: e.target.value.trim() })} />
      </label>
    </div>
  )
}
