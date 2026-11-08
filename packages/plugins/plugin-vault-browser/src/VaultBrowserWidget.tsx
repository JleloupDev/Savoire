// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { Icon, IconsContext } from './Icon'
import { useState, useEffect, useRef } from 'react'
import type { Widget, IconAPI } from '@savoire/plugin-api'

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
 * Une source de vaults : une section de la liste (ex. « Sur cet ordinateur »,
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
  /** Boutons propres a la source, sous ses vaults (ex. « Ouvrir un dossier… »). */
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
  /** `source` : la section ou le vault est cree, quand la liste a des sources. */
  onCreateVault: React.MutableRefObject<(name: string, source?: string) => Promise<void>>
  onRenameVault: React.MutableRefObject<(vault: TVault, name: string) => Promise<void>>
  onDeleteVault: React.MutableRefObject<(vault: TVault) => Promise<void>>
  onRefresh?: React.MutableRefObject<() => void>
  sharedWithMe?: React.MutableRefObject<SharedNoteLike[]>
  onOpenSharedNote?: React.MutableRefObject<(note: SharedNoteLike) => void>
  /** Copie d'un vault vers le poste et retour. Absent ou null : actions masquees. */
  vaultTransfer?: React.MutableRefObject<VaultTransferActions<TVault> | null>
  /** Sources de vaults (une section par source, l'une sous l'autre). Absent ou null : liste unique. */
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
    flex: 1, padding: '5px 8px', background: 'transparent',
    color, border: '1px solid var(--border, rgba(255,255,255,0.12))', borderRadius: 6,
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
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
        <button onClick={onClose} title="Fermer" style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: 0, display: 'inline-flex' }}><Icon name="x" size={14} /></button>
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
        <button onClick={() => void handleRename()} disabled={!name.trim() || name.trim() === vault.name} title="Renommer" style={{ ...S.btn('var(--text)'), flex: 'none', padding: '3px 8px' }}>
          <Icon name="check" size={14} />
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
  /** La source ou l'on cree un vault (sections) ; '' : liste unique. */
  const [createIn, setCreateIn] = useState<string>('')
  const inputRef = useRef<HTMLInputElement>(null)

  function sync() {
    setVaults([...refs.vaults.current])
    setSelectedId(refs.selectedVaultId.current)
    if (refs.sharedWithMe) setSharedNotes([...refs.sharedWithMe.current])
    const tabs = refs.sources?.current ?? null
    setSources(tabs ? [...tabs] : null)
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

  function startCreate(source: string) {
    setCreateIn(source)
    setNewName('')
    setCreating(true)
  }

  async function handleCreate() {
    const n = newName.trim()
    if (!n) return
    try {
      await refs.onCreateVault.current(n, createIn || undefined)
      setCreating(false); setNewName('')
      sync()
    } catch {}
  }

  const cancelCreate = () => { setCreating(false); setNewName('') }

  const createForm = (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 8px' }}>
      <input
        data-testid="vault-create-name"
        ref={inputRef}
        value={newName}
        onChange={e => setNewName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') cancelCreate() }}
        placeholder="Nom du vault"
        style={S.inp}
      />
      <div style={{ display: 'flex', gap: 4 }}>
        <button onClick={() => void handleCreate()} disabled={!newName.trim()} style={S.btn('var(--color-success, #4caf50)')}>OK</button>
        <button onClick={cancelCreate} style={S.btn('var(--color-danger, #f66)')}>Ann.</button>
      </div>
    </div>
  )

  const vaultRow = (v: TVault) => (
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
            {v.locked && <span title="Clé requise pour ouvrir ce vault" style={{ display: 'inline-flex', flexShrink: 0 }}><Icon name="lock" size={12} /></span>}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.name}</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {v.detail ?? `${v.role} · ${v.documentCount} doc${v.documentCount !== 1 ? 's' : ''}`}
          </div>
        </button>
        <button
          className="cfg-btn"
          onClick={() => setSettingsFor(prev => prev === v.id ? null : v.id)}
          style={{ opacity: 0, background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: '0 8px', display: 'inline-flex', alignItems: 'center', transition: 'opacity 0.1s' }}
          title="Paramètres"
        ><Icon name="settings" size={14} /></button>
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
  )

  const hasSources = !!sources && sources.length > 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'inherit', color: 'inherit', fontSize: 13 }}>
      <div style={{ padding: '8px 12px 4px', ...S.label }}>Vaults</div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {hasSources ? sources!.map((src, i) => {
          // Toutes les sources l'une sous l'autre : cet ordinateur, puis chaque serveur.
          const list = vaults.filter(v => v.source === src.id)
          return (
            <div key={src.id} data-testid="vault-source" data-source={src.id} style={{ marginTop: i ? 10 : 0 }}>
              <div title={src.title ?? src.label} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px 2px 12px' }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, fontWeight: 600, color: 'var(--text-faint)' }}>{src.label}</span>
                {src.canCreate !== false && (
                  <button
                    data-testid="vault-create-open"
                    data-source={src.id}
                    title={src.createLabel ?? 'Nouveau vault'}
                    onClick={() => startCreate(src.id)}
                    style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', fontSize: 14, lineHeight: 1, padding: '0 4px' }}
                  >+</button>
                )}
              </div>
              {list.map(vaultRow)}
              {list.length === 0 && (
                <div data-testid="vault-empty" style={{ padding: '2px 12px 4px', fontSize: 12, color: 'var(--text-faint)' }}>{src.emptyText ?? 'Aucun vault'}</div>
              )}
              {creating && createIn === src.id && createForm}
              {src.actions?.map(a => (
                <button key={a.id} data-testid={`vault-source-action-${a.id}`} onClick={() => a.run()} style={{ display: 'block', background: 'none', border: 'none', padding: '3px 12px', fontSize: 12, color: 'var(--accent)', cursor: 'pointer', textAlign: 'left' }}>
                  {a.label}
                </button>
              ))}
            </div>
          )
        }) : <>
          {vaults.map(vaultRow)}
          {vaults.length === 0 && (
            <div data-testid="vault-empty" style={{ padding: '4px 12px', fontSize: 12, color: 'var(--text-faint)' }}>Aucun vault</div>
          )}
        </>}

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

      {(!hasSources || refs.onRefresh) && (
      <div style={{ flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)', padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {!hasSources && creating ? createForm : (
          <div style={{ display: 'flex', gap: 4 }}>
            {!hasSources && (
            <button data-testid="vault-create-open" onClick={() => startCreate('')} style={{ ...S.btn('var(--text)'), flex: 1 }}>
              <Icon name="plus" size={14} />Nouveau vault
            </button>
            )}
            {refs.onRefresh && (
              <button
                onClick={() => refs.onRefresh!.current()}
                title="Actualiser"
                style={{ ...S.btn('var(--text-muted)'), flex: hasSources ? 1 : 'none', padding: '3px 8px' }}
              >
                <Icon name="refresh-cw" size={13} />{hasSources ? 'Actualiser' : ''}
              </button>
            )}
          </div>
        )}
      </div>
      )}
    </div>
  )
}

export class VaultBrowserWidget<TVault extends VaultSummaryLike = VaultSummaryLike> implements Widget {
  constructor(
    private readonly workspace: VaultBrowserWorkspaceLike,
    private readonly refs: VaultBrowserRefs<TVault>,
    private readonly icons?: IconAPI,
  ) {}

  render() {
    return (
      <IconsContext.Provider value={this.icons}>
        <VaultBrowserPanel workspace={this.workspace} refs={this.refs} />
      </IconsContext.Provider>
    )
  }

  dispose() {}
}
