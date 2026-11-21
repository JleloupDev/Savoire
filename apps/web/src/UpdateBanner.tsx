// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Version bureau : une nouvelle version se telecharge en fond, puis un
// bandeau propose de redemarrer. Jamais impose : on peut etre en train
// d'ecrire. Rien hors de Tauri ni dans les fenetres de note.

import { useEffect, useState } from 'react'
import { isAndroidRuntime, isTauriRuntime } from './tauriRuntime'
import type { DesktopUpdate, DesktopUpdates } from '@savoire/desktop'

/** Premiere recherche peu apres le demarrage, puis toutes les 6 heures. */
const FIRST_CHECK_MS = 15_000
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/** Cherche, et telecharge ce qui est trouve. La version prete, ou null. */
export async function findReadyUpdate(updates: DesktopUpdates): Promise<DesktopUpdate | null> {
  const update = await updates.check()
  if (!update) return null
  await updates.download()
  return update
}

export function UpdateBanner() {
  const [updates, setUpdates] = useState<DesktopUpdates | null>(null)
  const [ready, setReady] = useState<DesktopUpdate | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isTauriRuntime() || isAndroidRuntime()) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = async (u: DesktopUpdates) => {
      try {
        const found = await findReadyUpdate(u)
        if (!stopped && found) setReady(found)
      } catch (e) {
        console.warn('[mise a jour] recherche impossible', e)
      }
      if (!stopped) timer = setTimeout(() => void run(u), CHECK_EVERY_MS)
    }
    void (async () => {
      const { loadTauriBridge, createDesktopUpdates } = await import('@savoire/desktop')
      const u = createDesktopUpdates(await loadTauriBridge())
      if (stopped) return
      setUpdates(u)
      timer = setTimeout(() => void run(u), FIRST_CHECK_MS)
    })()
    return () => { stopped = true; if (timer) clearTimeout(timer) }
  }, [])

  if (!updates || !ready || dismissed === ready.version) return null

  const restart = async () => {
    setRestarting(true)
    setError(null)
    try {
      await updates.restart()
    } catch (e) {
      setRestarting(false)
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div data-testid="update-banner" role="status" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 16px', background: 'var(--accent)', color: 'var(--on-accent)', fontSize: 12.5, flexShrink: 0 }}>
      <span style={{ flex: 1 }}>
        {error
          ? `La mise à jour n'a pas pu s'installer : ${error}`
          : `Savoire ${ready.version} est prête (vous avez la ${ready.currentVersion}).`}
      </span>
      <button data-testid="update-restart" disabled={restarting} onClick={() => void restart()} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--on-accent)', background: 'var(--on-accent)', color: 'var(--accent)', fontSize: 12, fontWeight: 600, cursor: restarting ? 'wait' : 'pointer', fontFamily: 'var(--font-ui)' }}>
        {restarting ? 'Installation…' : 'Redémarrer'}
      </button>
      <button data-testid="update-later" disabled={restarting} onClick={() => setDismissed(ready.version)} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--on-accent-muted)', background: 'transparent', color: 'var(--on-accent)', fontSize: 12, cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
        Plus tard
      </button>
    </div>
  )
}
