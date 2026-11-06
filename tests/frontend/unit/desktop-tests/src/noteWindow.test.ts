// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fenetre d'une note (apps/web/src/noteWindow.ts) et session partagee avec
// la fenetre qui l'a ouverte (authBridge.ts) : une fenetre de note ne
// renouvelle jamais la session elle-meme.
import { describe, it, expect } from 'vitest'
import { readNoteWindow, noteWindowUrl, noteTitle } from '../../../../../apps/web/src/noteWindow'
import { connectAuthOverEvents, exposeBridge, findHostBridge, serveAuthOverEvents, HOST_KEY, type AuthBridge, type AuthEvents } from '../../../../../apps/web/src/authBridge'

const bridge = (token: string): AuthBridge => ({
  token: () => token, accounts: () => [], renew: async () => null, subscribe: () => () => {},
})

describe('fenetre de note', () => {
  it('lit et ecrit l\'adresse d\'une note seule', () => {
    const url = noteWindowUrl('v1', 'Bible/Genèse 1.md', false, 'https://x.fr')
    expect(readNoteWindow(new URL(url).search)).toEqual({ vaultId: 'v1', path: 'Bible/Genèse 1.md', pinned: false })
    expect(readNoteWindow(new URL(noteWindowUrl('v1', 'a.md', true, 'https://x.fr')).search)?.pinned).toBe(true)
    expect(readNoteWindow('?window=note&vault=v1')).toBeNull()
    expect(readNoteWindow('')).toBeNull()
    expect(noteTitle('Bible/Genèse 1.md')).toBe('Genèse 1')
  })

  it('trouve la session de la fenetre qui l\'a ouverte, ou de l\'hote de l\'incrustation', () => {
    const host = {} as Window
    exposeBridge(bridge('jeton-hote'), host)
    expect(findHostBridge({ opener: host, parent: null } as unknown as Window)?.token()).toBe('jeton-hote')
    // Cadre dans la fenetre d'incrustation : l'hote est pose sur elle.
    const pip = { [HOST_KEY]: host, opener: null } as unknown as Window
    const frame = { opener: null, parent: pip } as unknown as Window
    expect(findHostBridge(frame)?.token()).toBe('jeton-hote')
    expect(findHostBridge({ opener: null, parent: null } as unknown as Window)).toBeNull()
  })

  it('retirer la session exposee', () => {
    const w = {} as Window
    const off = exposeBridge(bridge('a'), w)
    off()
    expect(findHostBridge({ opener: w, parent: null } as unknown as Window)).toBeNull()
  })
})

/** Bus d'evenements simule : toutes les fenetres recoivent tout. */
function bus(): AuthEvents {
  const subs = new Map<string, Set<(p: unknown) => void>>()
  return {
    emit: async (event, payload) => { for (const cb of [...(subs.get(event) ?? [])]) cb(payload) },
    listen: async (event, cb) => {
      const set = subs.get(event) ?? new Set()
      subs.set(event, set)
      set.add(cb as (p: unknown) => void)
      return () => { set.delete(cb as (p: unknown) => void) }
    },
  }
}

describe('fenetre de note du bureau : session par evenements', () => {
  it('recoit le jeton de la fenetre principale, et ses renouvellements', async () => {
    const events = bus()
    let token = 'jeton-1'
    const listeners = new Set<(t: string | null) => void>()
    const main: AuthBridge = {
      token: () => token,
      accounts: () => [{ userId: 'u', email: 'a@b', displayName: 'A', refreshToken: 'secret', isActive: true }],
      renew: async () => { token = 'jeton-2'; for (const cb of listeners) cb(token); return token },
      subscribe: cb => { listeners.add(cb); return () => { listeners.delete(cb) } },
    }
    const stop = await serveAuthOverEvents(main, events)
    const note = await connectAuthOverEvents(events, 500)
    await note.ready
    expect(note.token()).toBe('jeton-1')
    expect(note.accounts()[0].userId).toBe('u')
    expect(note.accounts()[0].refreshToken).toBe('')
    const seen: (string | null)[] = []
    note.subscribe(t => seen.push(t))
    // Un 401 dans la fenetre de note : c'est la principale qui renouvelle.
    expect(await note.renew('jeton-1')).toBe('jeton-2')
    expect(note.token()).toBe('jeton-2')
    expect(seen).toContain('jeton-2')
    stop(); note.close()
  })

  it('sans fenetre principale : prete apres le delai, sans jeton', async () => {
    const note = await connectAuthOverEvents(bus(), 20)
    await note.ready
    expect(note.token()).toBeNull()
    expect(await Promise.race([note.renew('x'), new Promise(r => setTimeout(() => r('attente'), 50))])).toBe('attente')
    note.close()
  })

  it('la note posee par la fenetre du bureau passe avant l\'adresse', () => {
    const w = globalThis as unknown as { window?: unknown }
    const had = 'window' in w
    const prev = w.window
    w.window = { __SAVOIRE_NOTE_WINDOW__: { vaultId: 'v9', path: 'N.md', pinned: true }, location: { search: '' } }
    try {
      expect(readNoteWindow('')).toEqual({ vaultId: 'v9', path: 'N.md', pinned: true })
    } finally {
      if (had) w.window = prev; else delete w.window
    }
  })
})
