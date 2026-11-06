// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Fenetre d'une note (apps/web/src/noteWindow.ts) et session partagee avec
// la fenetre qui l'a ouverte (authBridge.ts) : une fenetre de note ne
// renouvelle jamais la session elle-meme.
import { describe, it, expect } from 'vitest'
import { readNoteWindow, noteWindowUrl, noteTitle } from '../../../../../apps/web/src/noteWindow'
import { exposeBridge, findHostBridge, HOST_KEY, type AuthBridge } from '../../../../../apps/web/src/authBridge'

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
