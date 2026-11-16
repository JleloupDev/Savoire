// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Panneau « Bible » : la Bible installee, le choix, le telechargement.
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, type ReactElement } from 'react'
import type { ViewContext } from '@savoire/plugin-api'
import { BIBLES, BibleWidget, type BibleHost, type InstallProgress } from '@savoire/plugin-bible'

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

const roots: Root[] = []
afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount())
  document.body.innerHTML = ''
})

async function mount(host: BibleHost): Promise<HTMLElement> {
  const div = document.createElement('div')
  document.body.appendChild(div)
  const root = createRoot(div)
  roots.push(root)
  const ctx = { workspace: { subscribeVaultChange: () => () => {} } } as unknown as ViewContext
  await act(async () => { root.render(new BibleWidget(ctx, host).render() as ReactElement) })
  return div
}

function host(over: Partial<BibleHost> = {}): BibleHost {
  return {
    folder: 'Bible/',
    bibles: BIBLES,
    installedId: async () => null,
    hasNotes: () => false,
    unavailable: () => null,
    install: async () => ({ written: 0, skipped: 0, cancelled: false }),
    ...over,
  }
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll('button')].find(b => b.textContent?.includes(text)) ?? null

describe('panneau Bible', () => {
  it('sur le web : la Bible proposee, le message, pas de bouton', async () => {
    const el = await mount(host({ unavailable: () => 'application bureau seulement' }))
    expect(el.textContent).toContain('Aucune Bible dans « Bible/ »')
    expect(el.textContent).toContain('Traduction du monde nouveau (révision 2018)')
    expect(el.textContent).toContain('application bureau seulement')
    expect(button(el, 'Télécharger')).toBeNull()
  })

  it('telecharge la Bible choisie, montre l\'avancement puis le resultat', async () => {
    let finish!: () => void
    let report!: (p: InstallProgress) => void
    let asked = ''
    const el = await mount(host({
      install: (id, onProgress) => {
        asked = id
        report = onProgress
        return new Promise(resolve => { finish = () => resolve({ written: 1256, skipped: 0, cancelled: false }) })
      },
    }))
    await act(async () => { button(el, 'Télécharger')!.click() })
    expect(asked).toBe('tmn-fr')
    await act(async () => { report({ done: 10, total: 1256, written: 10, skipped: 0, current: 'Bible/01 - Genèse/Genèse 10.md' }) })
    expect(el.textContent).toContain('10 / 1256 · Genèse 10')
    expect(button(el, 'Arrêter')).not.toBeNull()
    await act(async () => { finish() })
    expect(el.textContent).toContain('Terminé : 1256 note(s) écrite(s)')
  })

  it('la Bible installee est nommee', async () => {
    const el = await mount(host({ installedId: async () => 'tmn-fr' }))
    expect(el.textContent).toContain('Installée dans « Bible/ » : Traduction du monde nouveau')
  })
})
