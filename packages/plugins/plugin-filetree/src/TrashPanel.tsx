// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Corbeille de l'explorateur et fenetre de confirmation.
//
// La corbeille est un dossier `.trash/` du vault (voir VaultAPI.deleteFile) :
// elle n'apparait pas dans l'arborescence, seulement ici, en bas de
// l'explorateur. Pas de nettoyage automatique.
import { useEffect, useState } from 'react'
import type { TrashEntry, VaultAPI } from '@savoire/plugin-api'
import { emptyTrashRequest } from './trashMessages'

// ─── Fenetre de confirmation ──────────────────────────────────────────────

export type DialogChoice = 'confirm' | 'alt' | 'cancel'

export interface DialogRequest {
  title: string
  message: string
  confirmLabel: string
  /** Second choix, entre confirmer et annuler (ex. « Garder les sous-pages »). */
  altLabel?: string
  danger?: boolean
}

/** Fenetre de l'app (pas confirm() du navigateur). Entree confirme, Echap annule. */
export function ConfirmDialog({ request, onChoose }: { request: DialogRequest; onChoose: (c: DialogChoice) => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onChoose('cancel') }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onChoose('confirm') }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onChoose])

  return (
    <div
      data-testid="confirm-dialog"
      role="dialog"
      aria-modal="true"
      aria-label={request.title}
      onClick={() => onChoose('cancel')}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--bg-elevated, #2a2a2e)', color: 'var(--text, inherit)',
          border: '1px solid var(--border, rgba(255,255,255,0.12))', borderRadius: 8,
          padding: 18, width: 360, maxWidth: 'calc(100vw - 32px)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.35)', fontSize: 13,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{request.title}</div>
        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.45, marginBottom: 16 }}>{request.message}</div>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button data-testid="confirm-dialog-cancel" onClick={() => onChoose('cancel')} style={dialogBtn(false)}>Annuler</button>
          {request.altLabel && (
            <button data-testid="confirm-dialog-alt" onClick={() => onChoose('alt')} style={dialogBtn(false)}>{request.altLabel}</button>
          )}
          <button data-testid="confirm-dialog-confirm" autoFocus onClick={() => onChoose('confirm')} style={dialogBtn(true, request.danger)}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function dialogBtn(primary: boolean, danger = false): React.CSSProperties {
  const color = danger ? 'var(--color-danger, #dc2626)' : 'var(--accent, #7c3aed)'
  return {
    padding: '5px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
    border: `1px solid ${primary ? color : 'var(--border, rgba(255,255,255,0.15))'}`,
    background: primary ? color : 'transparent',
    color: primary ? '#fff' : 'inherit',
  }
}

// ─── Corbeille ────────────────────────────────────────────────────────────

export function TrashSection({
  vault, tick, onChanged, ask,
}: {
  vault: VaultAPI
  /** Change a chaque modification du vault : relit la corbeille. */
  tick: number
  onChanged: () => void
  ask: (request: DialogRequest) => Promise<DialogChoice>
}) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<TrashEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { setEntries(vault.listTrash?.() ?? []) }, [vault, tick])

  if (!vault.listTrash) return null

  async function run(action: () => Promise<unknown>) {
    try {
      setError(null)
      await action()
      setEntries(vault.listTrash?.() ?? [])
      onChanged()
    } catch (err) { setError(String(err)) }
  }

  async function purge(entry: TrashEntry) {
    const choice = await ask({
      title: 'Supprimer definitivement',
      message: `« ${entry.originalPath} » sera supprime definitivement. Cette action est irreversible.`,
      confirmLabel: 'Supprimer definitivement',
      danger: true,
    })
    if (choice !== 'confirm') return
    await run(() => vault.deleteFilePermanently?.(entry.documentId) ?? Promise.resolve())
  }

  async function emptyTrash() {
    if (entries.length === 0) return
    const choice = await ask(emptyTrashRequest(entries.length))
    if (choice !== 'confirm') return
    await run(async () => {
      for (const entry of entries) await vault.deleteFilePermanently?.(entry.documentId)
    })
  }

  const smallBtn: React.CSSProperties = {
    background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: '0 4px', flexShrink: 0,
    color: 'var(--text-muted, #bbb)',
  }

  return (
    <div data-testid="trash-section" style={{ flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)', fontSize: 12 }}>
      <div
        data-testid="trash-toggle"
        onClick={() => setOpen(o => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', cursor: 'pointer', userSelect: 'none' }}
        title="Documents mis a la corbeille"
      >
        <span style={{ width: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={{ flex: 1 }}>🗑 Corbeille</span>
        <span data-testid="trash-count" style={{ color: 'var(--text-muted, #999)' }}>{entries.length}</span>
      </div>
      {open && (
        <div style={{ maxHeight: 220, overflow: 'auto', paddingBottom: 4 }}>
          {entries.length === 0 && (
            <div style={{ padding: '2px 26px 6px', color: 'var(--text-muted, #999)' }}>La corbeille est vide.</div>
          )}
          {entries.map(entry => (
            <div
              key={entry.documentId}
              data-testid="trash-entry"
              data-path={entry.originalPath}
              style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px 2px 26px' }}
              title={entry.originalPath}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.originalPath}
              </span>
              {vault.restoreFromTrash && (
                <button data-testid="trash-restore" style={smallBtn} title="Restaurer"
                  onClick={() => void run(() => vault.restoreFromTrash!(entry.documentId))}>↺</button>
              )}
              {vault.deleteFilePermanently && (
                <button data-testid="trash-purge" style={{ ...smallBtn, color: 'var(--color-danger, #f66)' }}
                  title="Supprimer definitivement" onClick={() => void purge(entry)}>✕</button>
              )}
            </div>
          ))}
          {entries.length > 0 && vault.deleteFilePermanently && (
            <div style={{ padding: '4px 8px 2px' }}>
              <button data-testid="trash-empty" onClick={() => void emptyTrash()} style={{
                width: '100%', padding: '3px 6px', background: 'rgba(255,255,255,0.05)', borderRadius: 4,
                border: '1px solid rgba(255,255,255,0.1)', color: 'var(--color-danger, #f66)', fontSize: 11, cursor: 'pointer',
              }}>Vider la corbeille</button>
            </div>
          )}
          {error && <div style={{ padding: '2px 8px', color: 'var(--color-danger, #dc2626)' }}>{error}</div>}
        </div>
      )}
    </div>
  )
}
