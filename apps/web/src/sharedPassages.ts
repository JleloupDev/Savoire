// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// « Aussi dans… » : un paragraphe de la note ouverte qui se trouve a
// l'identique dans d'autres notes (copier-coller, passage deja ecrit) porte
// une pastille ; elle ouvre les autres notes. Vient de l'index (pouvoir
// `blocks`, methode `shared`) : sans index de tout le vault, rien.
import type { IIndexerAPI } from '@savoire/plugin-api'
import type { BlockMark } from '@savoire/editor-core'
import { liveBlocks, type BlocksSnapshot } from './liveBlocks'

const OWNER = 'shared'
const ENABLED_KEY = 'savoire-shared-passages'
/** L'index se met a jour apres la stabilisation de la note : on lui laisse le temps. */
const AFTER_STABLE_MS = 2500

function storage(): Storage | null {
  try { return window.localStorage } catch { return null }
}

export function sharedPassagesEnabled(): boolean {
  return storage()?.getItem(ENABLED_KEY) !== 'off'
}

interface Deps {
  indexer: () => IIndexerAPI | undefined
  open: (path: string) => void
}

let deps: Deps | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let ask: AbortController | null = null

function nameOf(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1)
  return file.replace(/\.md$/i, '')
}

async function refresh(snap: BlocksSnapshot | null): Promise<void> {
  ask?.abort()
  ask = null
  const blocks = deps?.indexer()?.blocks
  if (!snap || !blocks || !sharedPassagesEnabled() || !deps?.indexer()?.available()) { liveBlocks.setMarks(OWNER, []); return }
  const ac = new AbortController()
  ask = ac
  let found: Awaited<ReturnType<typeof blocks.shared>>
  try { found = await blocks.shared({ id: snap.docId, limit: 200 }, { signal: ac.signal }) } catch { return }
  if (ac.signal.aborted) return
  const now = liveBlocks.current()
  if (!now || now.docId !== snap.docId) return
  const marks: BlockMark[] = []
  for (const item of found.items) {
    // L'index peut avoir un temps de retard : le bloc est retrouve par son empreinte.
    const b = now.blocks.find(x => x.hash === item.hash)
    if (!b || !item.others.length) continue
    const names = item.others.map(o => `« ${o.title || nameOf(o.path)} »`)
    marks.push({
      from: b.from, to: b.to, className: 'cm-block-shared',
      badge: {
        label: `↔ ${item.others.length}`,
        className: 'cm-block-badge-shared',
        text: `Ce passage se trouve aussi dans ${names.slice(0, 5).join(', ')}${names.length > 5 ? '…' : ''}.`,
        actions: item.others.slice(0, 3).map(o => ({ label: `Ouvrir ${o.title || nameOf(o.path)}`, run: () => deps?.open(o.path) })),
      },
    })
  }
  liveBlocks.setMarks(OWNER, marks)
}

export function setSharedPassagesEnabled(on: boolean): void {
  storage()?.setItem(ENABLED_KEY, on ? 'on' : 'off')
  void refresh(liveBlocks.current())
}

/** Branche les pastilles « Aussi dans » (une fois, au demarrage). */
export function startSharedPassages(d: Deps): void {
  if (deps) return
  deps = d
  liveBlocks.onSwitch(snap => { void refresh(snap) })
  liveBlocks.onStable(snap => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void refresh(snap) }, AFTER_STABLE_MS)
  })
}
