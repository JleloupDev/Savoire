// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Ecran de choix du vault, version bureau : les dossiers ouverts recemment,
// « Ouvrir un dossier… » (un vault Obsidian existant ou un dossier vide) et
// « Nouveau vault… ». Aucun compte, aucun serveur.

import { useCallback, useEffect, useState } from 'react'
import type { DesktopHost, OpenedVaultFolder, RecentVault } from '@savoire/desktop'
import { notify } from '@savoire/notifications'

const btn: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text)', cursor: 'pointer',
  fontSize: 13, fontFamily: 'var(--font-ui)',
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function DesktopVaultPicker({ host, currentPath, onOpened, onClose, onServer }: {
  host: DesktopHost
  /** Dossier du vault ouvert, s'il y en a un. */
  currentPath: string | null
  onOpened: (folder: OpenedVaultFolder) => void
  /** Absent = rien d'ouvert, l'ecran ne se ferme pas. */
  onClose?: () => void
  /** Vers les vaults d'un serveur Savoire (pour en telecharger un). Optionnel. */
  onServer?: () => void
}) {
  const [recent, setRecent] = useState<RecentVault[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    host.listRecent().then(setRecent).catch(err => {
      console.error('[desktop] liste des vaults', err)
      setRecent([])
    })
  }, [host])
  useEffect(refresh, [refresh])

  // Un seul choix a la fois : la boite de dialogue native est modale.
  async function run(action: () => Promise<OpenedVaultFolder | null>) {
    if (busy) return
    setBusy(true)
    try {
      const folder = await action()
      if (folder) onOpened(folder)
    } catch (err) {
      notify('danger', 'Impossible d\'ouvrir le vault', errorText(err))
      refresh()
    } finally {
      setBusy(false)
    }
  }

  function create() {
    const n = name.trim()
    if (!n) return
    void run(async () => {
      const folder = await host.createVaultFolder(n)
      if (folder) { setCreating(false); setName('') }
      return folder
    })
  }

  async function forget(v: RecentVault) {
    try {
      await host.forgetRecent(v.path)
    } catch (err) {
      notify('danger', 'Impossible de retirer le vault', errorText(err))
    }
    refresh()
  }

  return (
    <div
      data-testid="desktop-picker"
      onClick={onClose}
      style={{ position: 'absolute', inset: 0, zIndex: 900, background: 'var(--bg-base)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div onClick={e => e.stopPropagation()} style={{ width: 520, maxWidth: '92%', maxHeight: '86%', display: 'flex', flexDirection: 'column', gap: 16, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 24, boxShadow: 'var(--shadow)', position: 'relative' }}>
        {onClose && (
          <button onClick={onClose} title="Fermer" style={{ position: 'absolute', top: 12, right: 14, background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer' }}>✕</button>
        )}
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Vaults sur cet ordinateur</div>
          <div style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 4 }}>
            Un vault est un dossier : vos notes y restent en fichiers Markdown, lisibles par d'autres outils.
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 60, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {recent === null && <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Chargement…</div>}
          {recent?.length === 0 && (
            <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Aucun vault récent. Ouvrez un dossier ou créez un vault.</div>
          )}
          {recent?.map(v => {
            const missing = v.exists === false
            const current = v.path === currentPath
            return (
              <div key={v.path} style={{ display: 'flex', alignItems: 'center', gap: 6, borderRadius: 6, background: current ? 'var(--accent-dim)' : 'transparent' }}>
                <button
                  data-testid="desktop-recent-item"
                  data-path={v.path}
                  disabled={missing || busy}
                  onClick={() => void run(() => host.openRecent(v.path))}
                  title={missing ? 'Dossier introuvable (déplacé, renommé ou disque débranché)' : v.path}
                  style={{ flex: 1, minWidth: 0, textAlign: 'left', padding: '7px 10px', border: 'none', background: 'transparent', color: missing ? 'var(--text-faint)' : 'var(--text)', cursor: missing ? 'default' : 'pointer', fontFamily: 'var(--font-ui)' }}
                >
                  <div style={{ fontSize: 13.5, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {v.name}{missing && ' — introuvable'}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.path}</div>
                </button>
                <button
                  data-testid="desktop-recent-forget"
                  onClick={() => void forget(v)}
                  title="Retirer de la liste (le dossier n'est pas supprimé)"
                  style={{ background: 'none', border: 'none', color: 'var(--text-faint)', cursor: 'pointer', padding: '0 10px', fontSize: 13 }}
                >✕</button>
              </div>
            )
          })}
        </div>

        {creating ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              data-testid="desktop-new-vault-name"
              autoFocus
              value={name}
              placeholder="Nom du vault"
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') create(); if (e.key === 'Escape') setCreating(false) }}
              style={{ flex: 1, padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-base)', color: 'var(--text)', fontSize: 13 }}
            />
            <button data-testid="desktop-new-vault-confirm" disabled={busy || !name.trim()} onClick={create} style={btn}>Choisir où…</button>
            <button onClick={() => setCreating(false)} style={btn}>Annuler</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8 }}>
            <button data-testid="desktop-open-folder" disabled={busy} onClick={() => void run(() => host.pickVaultFolder())} style={{ ...btn, background: 'var(--accent)', color: '#fff', border: 'none' }}>
              Ouvrir un dossier…
            </button>
            <button data-testid="desktop-new-vault" disabled={busy} onClick={() => setCreating(true)} style={btn}>Nouveau vault…</button>
            {onServer && (
              <button data-testid="desktop-server" disabled={busy} onClick={onServer} title="Se connecter à un serveur Savoire pour télécharger un de ses vaults dans un dossier" style={{ ...btn, marginLeft: 'auto', background: 'transparent' }}>
                Serveur Savoire…
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
