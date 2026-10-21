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
  /** Source du vault (onglet ou il s'affiche), quand l'app en a plusieurs. */
  source?: string
  /** Seconde ligne (ex. le dossier d'un vault local). Absente : role et documents. */
  detail?: string
}

/**
 * Une source de vaults : un onglet de la liste (ex. « Sur cet ordinateur »,
 * « savoire.exemple.fr »). Sans sources, la liste est unique, comme avant.
 */
export interface VaultSourceTab {
  id: string
  label: string
  title?: string
  /** Texte quand la source n'a aucun vault (ex. « Non connecté. »). */
  emptyText?: string
  /** false : pas de « + Nouveau vault » pour cette source. */
  canCreate?: boolean
  /** Libelle du bouton de creation (defaut « + Nouveau vault »). */
  createLabel?: string
  /** Boutons propres a la source, en bas de la liste (ex. « Ouvrir un dossier… »). */
  actions?: Array<{ id: string; label: string; run(): void }>
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
  /** `source` : l'onglet actif, quand la liste a des sources. */
  onCreateVault: React.MutableRefObject<(name: string, source?: string) => Promise<void>>
  onRenameVault: React.MutableRefObject<(vault: TVault, name: string) => Promise<void>>
  onDeleteVault: React.MutableRefObject<(vault: TVault) => Promise<void>>
  onRefresh?: React.MutableRefObject<() => void>
  sharedWithMe?: React.MutableRefObject<SharedNoteLike[]>
  onOpenSharedNote?: React.MutableRefObject<(note: SharedNoteLike) => void>
  /** Copie d'un vault vers le poste et retour. Absent ou null : actions masquees. */
  vaultTransfer?: React.MutableRefObject<VaultTransferActions<TVault> | null>
  /** Sources de vaults (un onglet par source). Absent ou null : liste unique. */
  sources?: React.MutableRefObject<VaultSourceTab[] | null>
}

/** Une action du menu d'un vault. */
export interface VaultMenuAction<TVault extends VaultSummaryLike = VaultSummaryLike> {
  label: string
  run(vault: TVault): void
  /** Absent : l'action vaut pour tout vault. */
  appliesTo?(vault: TVault): boolean
}

/**
 * Copie d'un vault, fournie par l'app selon ce qu'elle sait faire : telecharger
 * dans un dossier du poste (bureau) ou exporter un .zip (navigateur) ; envoyer
 * un vault du poste sur le serveur (bureau). Absente : action masquee.
 */
export interface VaultTransferActions<TVault extends VaultSummaryLike = VaultSummaryLike> {
  download?: VaultMenuAction<TVault>
  upload?: VaultMenuAction<TVault>
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

function VaultSettings<TVault extends VaultSummaryLike>({ vault, onRename, onDelete, onClose, transfer }: {
  vault: TVault
  onRename: (name: string) => Promise<void>
  onDelete: () => Promise<void>
  onClose: () => void
  transfer?: VaultTransferActions<TVault> | null
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

      {transfer && !vault.locked && ([['vault-download', transfer.download], ['vault-upload', transfer.upload]] as const).map(([testId, action]) => action && (action.appliesTo?.(vault) ?? true) && (
        <button
          key={testId}
          data-testid={testId}
          onClick={() => { action.run(vault); onClose() }}
          style={{ ...S.btn('var(--text-muted)'), textAlign: 'left' }}
        >
          {action.label}
        </button>
      ))}

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
  const [sharedNotes, setSharedNotes] = useState<SharedNoteLike[]>([])
  const [sources, setSources] = useState<VaultSourceTab[] | null>(null)
  const [activeSource, setActiveSource] = useState<string | null>(null)
  const lastSelectedRef = useRef<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  function sync() {
    const list = [...refs.vaults.current]
    const selected = refs.selectedVaultId.current
    setVaults(list)
    setSelectedId(selected)
    if (refs.sharedWithMe) setSharedNotes([...refs.sharedWithMe.current])
    const tabs = refs.sources?.current ?? null
    setSources(tabs ? [...tabs] : null)
    if (tabs?.length) {
      // Un autre vault vient d'etre ouvert : on montre l'onglet de sa source.
      const selectedSource = list.find(v => v.id === selected)?.source
      if (selected !== lastSelectedRef.current && selectedSource) setActiveSource(selectedSource)
      else setActiveSource(cur => cur && tabs.some(t => t.id === cur) ? cur : tabs[0].id)
    }
    lastSelectedRef.current = selected
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
      await refs.onCreateVault.current(n, tab?.id)
      setCreating(false); setNewName('')
      sync()
    } catch {}
  }

  const tab = sources?.find(t => t.id === activeSource) ?? sources?.[0] ?? null
  const shown = tab ? vaults.filter(v => v.source === tab.id) : vaults
  const selectedSource = vaults.find(v => v.id === selectedId)?.source
  const canCreate = tab ? tab.canCreate !== false : true

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'inherit', color: 'inherit', fontSize: 13 }}>
      <div style={{ padding: '8px 12px 4px', ...S.label }}>Vaults</div>

      {sources && sources.length > 0 && (
        <div data-testid="vault-sources" style={{ display: 'flex', gap: 4, padding: '2px 8px 6px', flexWrap: 'wrap' }}>
          {sources.map(src => {
            const active = src.id === tab?.id
            return (
              <button
                key={src.id}
                data-testid="vault-source-tab"
                data-source={src.id}
                data-active={active ? 'true' : 'false'}
                title={src.title ?? src.label}
                onClick={() => { setActiveSource(src.id); setSettingsFor(null); setCreating(false) }}
                style={{
                  flex: '1 1 0', minWidth: 0, padding: '4px 8px', borderRadius: 5, fontSize: 11.5, cursor: 'pointer',
                  border: `1px solid ${active ? 'var(--accent)' : 'rgba(255,255,255,0.1)'}`,
                  background: active ? 'var(--accent-dim)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--text-muted)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {src.id === selectedSource && <span title="Le vault ouvert vient d'ici" style={{ marginRight: 4 }}>●</span>}
                {src.label}
              </button>
            )
          })}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {shown.map(v => (
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
                data-testid="vault-item"
                data-vault-id={v.id}
                data-vault-name={v.name}
                data-vault-locked={v.locked ? 'true' : 'false'}
                onClick={() => handleSelect(v)}
                style={{ flex: 1, textAlign: 'left', padding: '5px 12px', border: 'none', background: 'transparent', color: v.locked ? 'var(--text-faint)' : v.id === selectedId ? 'var(--text)' : 'var(--text-muted)', cursor: 'pointer', minWidth: 0 }}
              >
                <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 5 }}>
                  {v.locked && <span title="Clé requise pour ouvrir ce vault" style={{ fontSize: 10, flexShrink: 0 }}>🔒</span>}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {v.detail ?? `${v.role} · ${v.documentCount} doc${v.documentCount !== 1 ? 's' : ''}`}
                </div>
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
                transfer={refs.vaultTransfer?.current}
              />
            )}
          </div>
        ))}

        {shown.length === 0 && (
          <div data-testid="vault-empty" style={{ padding: '4px 12px', fontSize: 12, color: 'var(--text-faint)' }}>{tab?.emptyText ?? 'Aucun vault'}</div>
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
              data-testid="vault-create-name"
              ref={inputRef}
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }}
              placeholder="Nom du vault"
              style={S.inp}
            />
            <div style={{ display: 'flex', gap: 4 }}>
              <button onClick={() => void handleCreate()} disabled={!newName.trim()} style={S.btn('var(--color-success, #4caf50)')}>OK</button>
              <button onClick={() => { setCreating(false); setNewName('') }} style={S.btn('var(--color-danger, #f66)')}>Ann.</button>
            </div>
          </>
        ) : (
          <>
          {tab?.actions?.map(a => (
            <button key={a.id} data-testid={`vault-source-action-${a.id}`} onClick={() => a.run()} style={{ ...S.btn('var(--text)'), textAlign: 'left' }}>
              {a.label}
            </button>
          ))}
          <div style={{ display: 'flex', gap: 4 }}>
            {canCreate && (
            <button data-testid="vault-create-open" onClick={() => setCreating(true)} style={{ ...S.btn('var(--color-success, #4caf50)'), flex: 1, textAlign: 'left' }}>
              {tab?.createLabel ?? '+ Nouveau vault'}
            </button>
            )}
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
          </>
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
