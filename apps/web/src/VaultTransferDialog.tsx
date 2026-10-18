// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fenetre de progression d'un telechargement ou d'un envoi de vault : barre,
// compteurs, annulation, puis resume (copies, deja presents, erreurs).
// Fermer la fenetre pendant la copie ne l'arrete pas : une notification
// annonce la fin (voir announceTransfer).
import { useEffect, useState } from 'react'
import type { VaultTransferProgress, VaultTransferResult } from '@savoire/application'
import { summarize, type VaultTransferRun } from './vaultTransfer'

const PHASES: Record<VaultTransferProgress['phase'], string> = {
  preparing: 'Préparation…',
  documents: 'Copie des documents…',
  maps: 'Copie des réglages et de la revue…',
  finishing: 'Vérification de l\'envoi…',
  done: 'Terminé',
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`
  return `${(n / 1024 / 1024).toFixed(1)} Mo`
}

const btn: React.CSSProperties = {
  padding: '5px 14px', borderRadius: 6, border: '1px solid var(--border)',
  background: 'var(--bg-elevated)', color: 'var(--text)', cursor: 'pointer', fontSize: 13,
}

export function VaultTransferDialog({ run, onClose }: { run: VaultTransferRun; onClose: () => void }) {
  const [progress, setProgress] = useState<VaultTransferProgress>(run.job.progress)
  const [result, setResult] = useState<VaultTransferResult | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  useEffect(() => {
    let open = true
    const unsub = run.job.onProgress(p => { if (open) setProgress(p) })
    run.job.result.then(
      r => { if (open) setResult(r) },
      err => { if (open) setFailure(err instanceof Error ? err.message : String(err)) },
    )
    return () => { open = false; unsub() }
  }, [run])

  const running = !result && !failure
  const fraction = progress.total > 0 ? progress.done / progress.total : 0

  return (
    <div data-testid="vault-transfer-dialog" style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 10, boxShadow: 'var(--shadow-lg)', width: 440, maxWidth: '90vw', padding: 18, display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13, color: 'var(--text)' }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{run.title}</div>

        {running && (
          <>
            <div style={{ color: 'var(--text-muted)' }}>{cancelling ? 'Annulation…' : PHASES[progress.phase]}</div>
            <div style={{ height: 6, borderRadius: 3, background: 'var(--bg-elevated)', overflow: 'hidden' }}>
              <div data-testid="vault-transfer-bar" style={{ height: '100%', width: `${Math.round(fraction * 100)}%`, background: 'var(--accent, #0d9488)', transition: 'width 0.2s' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-faint)', fontSize: 12 }}>
              <span>{progress.done} / {progress.total} éléments · {formatBytes(progress.bytes)}</span>
            </div>
            {progress.current && (
              <div style={{ color: 'var(--text-faint)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{progress.current}</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button style={btn} onClick={onClose} title="La copie continue ; une notification annoncera la fin">Masquer</button>
              <button data-testid="vault-transfer-cancel" style={btn} disabled={cancelling} onClick={() => { setCancelling(true); run.job.cancel() }}>Annuler</button>
            </div>
          </>
        )}

        {failure && (
          <>
            <div style={{ color: 'var(--color-danger, #f66)' }}>{failure}</div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button style={btn} onClick={onClose}>Fermer</button></div>
          </>
        )}

        {result && (
          <>
            <div data-testid="vault-transfer-summary">
              {result.cancelled ? 'Annulé. ' : ''}{summarize(result)} · {formatBytes(result.bytes)}.
              {!result.cancelled && !result.errors.length && <> {run.doneLabel(result)}</>}
            </div>
            {Object.keys(result.renamedPaths).length > 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                {Object.keys(result.renamedPaths).length} document(s) renommé(s) : un autre document portait déjà ce nom.
              </div>
            )}
            {result.errors.length > 0 && (
              <div style={{ maxHeight: 160, overflowY: 'auto', fontSize: 12, color: 'var(--color-danger, #f66)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {result.errors.map((e, i) => <div key={i}><strong>{e.path}</strong> : {e.message}</div>)}
              </div>
            )}
            {(result.cancelled || result.errors.length > 0) && (
              <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>Relancer la copie complète ce qui manque, sans rien dupliquer.</div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}><button data-testid="vault-transfer-close" style={btn} onClick={onClose}>Fermer</button></div>
          </>
        )}
      </div>
    </div>
  )
}
