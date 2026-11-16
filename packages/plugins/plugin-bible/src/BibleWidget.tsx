// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau « Bible » : la Bible installee dans le dossier, le choix d'une
// Bible a telecharger, et l'avancement du telechargement.
import { useEffect, useRef, useState } from 'react'
import type { ViewContext, Widget } from '@savoire/plugin-api'
import type { BibleEdition } from './bibles'
import type { InstallProgress, InstallResult } from './install'

export interface BibleHost {
  folder: string
  bibles: readonly BibleEdition[]
  /** Id de la Bible du dossier, null si aucune (ou des notes sans index). */
  installedId(): Promise<string | null>
  /** Le dossier a-t-il deja des chapitres ? */
  hasNotes(): boolean
  /** Null : telechargement possible. Sinon : pourquoi pas (web, pas de vault). */
  unavailable(): string | null
  install(id: string, onProgress: (p: InstallProgress) => void, cancelled: () => boolean): Promise<InstallResult>
}

function BiblePanel({ ctx, host }: { ctx: ViewContext; host: BibleHost }) {
  const [chosen, setChosen] = useState(host.bibles[0]?.id ?? '')
  const [installed, setInstalled] = useState<string | null>(null)
  const [hasNotes, setHasNotes] = useState(false)
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const [tick, setTick] = useState(0)
  const cancel = useRef(false)

  useEffect(() => ctx.workspace.subscribeVaultChange?.(() => setTick(t => t + 1)), [ctx])
  useEffect(() => {
    let live = true
    void host.installedId().then(id => { if (live) { setInstalled(id); setHasNotes(host.hasNotes()) } })
    return () => { live = false }
  }, [host, tick])

  const busy = progress !== null
  const unavailable = host.unavailable()
  const nameOf = (id: string | null) => host.bibles.find(b => b.id === id)?.name ?? id

  const start = async () => {
    cancel.current = false
    setMessage(null)
    setProgress({ done: 0, total: 1, written: 0, skipped: 0 })
    try {
      const r = await host.install(chosen, setProgress, () => cancel.current)
      setMessage(r.cancelled
        ? { kind: 'ok', text: `Arrêté : ${r.written} note(s) écrite(s). Relancez pour reprendre.` }
        : { kind: 'ok', text: `Terminé : ${r.written} note(s) écrite(s), ${r.skipped} déjà présente(s).` })
    } catch (err) {
      setMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    } finally {
      setProgress(null)
      setTick(t => t + 1)
    }
  }

  const S = {
    panel: { height: '100%', overflow: 'auto' as const, padding: '10px 12px', fontSize: 13, color: 'var(--text)', display: 'flex', flexDirection: 'column' as const, gap: 12 },
    title: { fontWeight: 600, fontSize: '0.7rem', textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: 'var(--text-faint)' },
    muted: { color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.45 },
    option: { display: 'flex', gap: 8, alignItems: 'flex-start', padding: '8px', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' },
    button: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--accent)', color: 'var(--accent-contrast, #fff)', cursor: 'pointer' },
    secondary: { padding: '6px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text)', cursor: 'pointer' },
    bar: { height: 6, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' as const },
  }

  return (
    <div style={S.panel}>
      <div style={S.title}>Bible du vault</div>
      <div style={S.muted}>
        {installed
          ? <>Installée dans « {host.folder} » : <strong>{nameOf(installed)}</strong>.</>
          : hasNotes
            ? <>Le dossier « {host.folder} » contient déjà des chapitres (installés à la main).</>
            : <>Aucune Bible dans « {host.folder} ».</>}
      </div>

      <div style={S.title}>Choisir sa Bible</div>
      {host.bibles.map(b => (
        <label key={b.id} style={{ ...S.option, borderColor: chosen === b.id ? 'var(--accent)' : 'var(--border)' }}>
          <input type="radio" name="bible" checked={chosen === b.id} disabled={busy} onChange={() => setChosen(b.id)} />
          <span>
            <span style={{ fontWeight: 600 }}>{b.name}</span>
            <span style={{ ...S.muted, display: 'block' }}>{b.description}</span>
          </span>
        </label>
      ))}

      {unavailable
        ? <div style={S.muted}>{unavailable}</div>
        : busy
          ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={S.bar}><div style={{ height: '100%', width: `${Math.round(100 * progress.done / Math.max(1, progress.total))}%`, background: 'var(--accent)' }} /></div>
              <div style={S.muted}>{progress.done} / {progress.total}{progress.current ? ` · ${progress.current.slice(progress.current.lastIndexOf('/') + 1).replace(/\.md$/, '')}` : ''}</div>
              <div><button style={S.secondary} onClick={() => { cancel.current = true }}>Arrêter</button></div>
            </div>
          )
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div><button style={S.button} disabled={!chosen} onClick={() => void start()}>Télécharger dans « {host.folder} »</button></div>
              <div style={S.muted}>Environ 1 200 pages, quelques minutes. Les notes déjà présentes sont gardées telles quelles.</div>
            </div>
          )}

      {message && <div style={{ ...S.muted, color: message.kind === 'error' ? 'var(--danger, #c33)' : 'var(--text-muted)' }}>{message.text}</div>}
    </div>
  )
}

export class BibleWidget implements Widget {
  constructor(private readonly ctx: ViewContext, private readonly host: BibleHost) {}
  render() { return <BiblePanel ctx={this.ctx} host={this.host} /> }
  dispose(): void {}
}
