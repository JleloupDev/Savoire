// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useRef } from 'react'
import type { Widget } from '@savoire/plugin-api'

export interface VaultSummaryLike {
  id: string
  name: string
  role: string
  documentCount: number
  folderCount: number
  /** True when this vault can't be opened with whatever key the caller
   *  currently holds — rendered as a lock badge, never blocks the row from
   *  showing (see VaultBrowserPanel below). */
  locked: boolean
}

export interface SharedNoteLike {
  documentId: string
  vaultId: string
  path: string
  permission: string
  grantedByDisplayName: string
}

export interface VaultBrowserRefs<TVault extends VaultSummaryLike = VaultSummaryLike> {
  vaults: React.MutableRefObject<TVault[]>
  selectedVaultId: React.MutableRefObject<string | null>
  onSelectVault: React.MutableRefObject<(vault: TVault) => void>
  onCreateVault: React.MutableRefObject<(name: string, isManaged: boolean) => Promise<void>>
  onRenameVault: React.MutableRefObject<(vault: TVault, name: string) => Promise<void>>
  onDeleteVault: React.MutableRefObject<(vault: TVault) => Promise<void>>
  onRefresh?: React.MutableRefObject<() => void>
  sharedWithMe?: React.MutableRefObject<SharedNoteLike[]>
  onOpenSharedNote?: React.MutableRefObject<(note: SharedNoteLike) => void>
}

export interface VaultBrowserWorkspaceLike {
  subscribeVaultChange?: (cb: () => void) => () => void
}

const S = {
  inp: {
    padding: '4px 7px', background: 'rgba(255,255,255,0.07)',
    color: 'inherit', border: '1px solid rgba(255,255,255,0.15)',
    borderRadius: 4, fontSize: 12, outline: 'none', width: '100%',
    boxSizing: 'border-box',
  } as React.CSSProperties,
  btn: (color: string): React.CSSProperties => ({
    flex: 1, padding: '3px 6px', background: 'rgba(255,255,255,0.05)',
    color, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4,
    fontSize: 11, cursor: 'pointer',
  }),
  label: {
    fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-faint)',
    textTransform: 'uppercase' as const, letterSpacing: '0.08em',
  },
}

function VaultSettings<TVault extends VaultSummaryLike>({ vault, onRename, onDelete, onClose }: {
  vault: TVault
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(vault.name)
  const [confirmDel, setConfirmDel] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function handleRename() {
    if (!name.trim() || name.trim() === vault.name) return
    try { await onRename(name.trim()); onClose() }
    catch { setErr('Erreur renommage.') }
  }

  async function handleDelete() {
    try { await onDelete(); onClose() }
    catch { setErr('Erreur suppression.') }
  }

  return (
    <div style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.04))', borderRadius: 6, padding: '10px 10px 8px', margin: '0 4px 4px', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>{vault.name}</span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0 }}>✕</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
        {[['Docs', vault.documentCount], ['Dossiers', vault.folderCount]].map(([k, v]) => (
          <div key={String(k)} style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 4, padding: '4px 7px' }}>
            <div style={{ fontSize: 9, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{k}</div>
            <div style={{ fontWeight: 600 }}>{v}</div>
          </div>
        ))}
      </div>

      {err && <div style={{ color: 'var(--color-danger, #f66)', fontSize: 11 }}>{err}</div>}

      <div style={{ display: 'flex', gap: 4 }}>
        <input value={name} onChange={e => setName(e.target.value)} onKeyDown={e => e.key === 'Enter' && void handleRename()} style={{ ...S.inp, flex: 1 }} />
        <button onClick={() => void handleRename()} disabled={!name.trim() || name.trim() === vault.name} style={{ ...S.btn('var(--color-success, #4caf50)'), flex: 'none', padding: '3px 10px' }}>
          ↩
        </button>
      </div>

      {confirmDel ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, color: 'var(--color-danger, #f66)' }}>Supprimer <strong>{vault.name}</strong> ?</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => void handleDelete()} style={S.btn('var(--color-danger, #f66)')}>Supprimer</button>
            <button onClick={() => setConfirmDel(false)} style={S.btn('var(--text-muted)')}>Annuler</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setConfirmDel(true)} style={{ ...S.btn('var(--color-danger, #f66)'), textAlign: 'left' }}>
          Supprimer...
        </button>
      )}
    </div>
  )
}

function VaultBrowserPanel<TVault extends VaultSummaryLike>({
  workspace,
  refs,
}: {
  workspace: VaultBrowserWorkspaceLike
  refs: VaultBrowserRefs<TVault>
}) {
  const [vaults, setVaults] = useState<TVault[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settingsFor, setSettingsFor] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [managed, setManaged] = useState(false)
  const [sharedNotes, setSharedNotes] = useState<SharedNoteLike[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  function sync() {
    setVaults([...refs.vaults.current])
    setSelectedId(refs.selectedVaultId.current)
    if (refs.sharedWithMe) setSharedNotes([...refs.sharedWithMe.current])
  }

  useEffect(() => {
    sync()
    return workspace.subscribeVaultChange?.(() => sync())
  }, [workspace])

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  function handleSelect(vault: TVault) {
    setSelectedId(vault.id)
    setSettingsFor(null)
    refs.onSelectVault.current(vault)
  }

  async function handleCreate() {
    const n = newName.trim()
    if (!n) return
    try {
      await refs.onCreateVault.current(n, managed)
      setCreating(false); setNewName(''); setManaged(false)
      sync()
    } catch {}
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'inherit', color: 'inherit', fontSize: 13 }}>
      <div style={{ padding: '8px 12px 4px', ...S.label }}>Vaults</div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {vaults.map(v => (
          <div key={v.id}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 2,
                background: v.id === selectedId ? 'rgba(255,255,255,0.08)' : 'transparent',
              }}
              onMouseEnter={e => {
                if (v.id !== selectedId && !v.locked) (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)'
                const btn = (e.currentTarget as HTMLElement).querySelector('.cfg-btn') as HTMLElement | null
                if (btn) btn.style.opacity = '1'
              }}
              onMouseLeave={e => {
                if (v.id !== selectedId) (e.currentTarget as HTMLElement).style.background = 'transparent'
                const btn = (e.currentTarget as HTMLElement).querySelector('.cfg-btn') as HTMLElement | null
                if (btn) btn.style.opacity = '0'
              }}
            >
              <button
                onClick={() => handleSelect(v)}
                style={{ flex: 1, textAlign: 'left', padding: '5px 12px', border: 'none', background: 'transparent', color: v.locked ? 'var(--text-faint)' : v.id === selectedId ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', minWidth: 0 }}
              >
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {v.locked && <span title="Clé requise pour ouvrir ce vault" style={{ fontSize: 10, flexShrink: 0 }}>🔒</span>}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>{v.role} · {v.documentCount} doc{v.documentCount !== 1 ? 's' : ''}</div>
              </button>
              <button
                className="cfg-btn"
                onClick={() => setSettingsFor(prev => prev === v.id ? null : v.id)}
                style={{ opacity: 0, background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: '0 8px', fontSize: 13, transition: 'opacity 0.1s' }}
                title="Paramètres"
              >⚙</button>
            </div>

            {settingsFor === v.id && (
              <VaultSettings
                vault={v}
                onRename={(name) => refs.onRenameVault.current(v, name).then(sync)}
                onDelete={() => refs.onDeleteVault.current(v).then(sync)}
                onClose={() => setSettingsFor(null)}
              />
            )}
          </div>
        ))}

        {vaults.length === 0 && (
          <div style={{ padding: '4px 12px', fontSize: 12, color: 'var(--text-faint)' }}>Aucun vault</div>
        )}

        {sharedNotes.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ padding: '4px 12px', ...S.label }}>Partagé avec moi</div>
            {sharedNotes.map(note => (
              <button
                key={note.documentId}
                onClick={() => refs.onOpenSharedNote?.current(note)}
                title={`Par ${note.grantedByDisplayName} · ${note.permission}`}
                style={{
                  width: '100%', textAlign: 'left', padding: '5px 12px',
                  border: 'none', background: 'transparent',
                  color: 'var(--text-muted)', cursor: 'pointer',
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.04)' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
              >
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 500 }}>
                  {note.path.split('/').pop()}
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)' }}>
                  {note.permission} · {note.grantedByDisplayName}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div style={{ flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {creating ? (
          <>
            <input
              ref={inputRef}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName(''); setManaged(false) } }}
              placeholder="Nom du vault"
              style={S.inp}
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--text-faint)', padding: '2px 4px', cursor: 'pointer' }}>
              <input type="checkbox" checked={managed} onChange={e => setManaged(e.target.checked)} />
              Géré par le serveur
            </label>
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => void handleCreate()} disabled={!newName.trim()} style={S.btn('var(--color-success, #4caf50)')}>OK</button>
              <button onClick={() => { setCreating(false); setNewName(''); setManaged(false) }} style={S.btn('var(--color-danger, #f66)')}>Ann.</button>
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={() => setCreating(true)} style={{ ...S.btn('var(--color-success, #4caf50)'), flex: 1, textAlign: 'left' }}>
              + Nouveau vault
            </button>
            {refs.onRefresh && (
              <button
                onClick={() => refs.onRefresh!.current()}
                title="Actualiser"
                style={{ ...S.btn('var(--text-muted)'), flex: 'none', padding: '3px 8px' }}
              >
                ↺
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export class VaultBrowserWidget<TVault extends VaultSummaryLike = VaultSummaryLike> implements Widget {
  constructor(
    private readonly workspace: VaultBrowserWorkspaceLike,
    private readonly refs: VaultBrowserRefs<TVault>,
  ) {}

  render() {
    return <VaultBrowserPanel workspace={this.workspace} refs={this.refs} />
  }

  dispose() {}
}
