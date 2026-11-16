// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Videos et sons : ![[x.mp4]] devient un lecteur ; le fichier s'ouvre dans un lecteur.
import { describe, it, expect, vi } from 'vitest'
import { parseMediaEmbed, isMediaPath, createPlayer, createVideoPlugin } from '@savoire/plugin-video'
import type { VaultAPI } from '@savoire/plugin-api'

describe('plugin-video', () => {
  it('reconnait les integrations de videos et de sons', () => {
    expect(parseMediaEmbed('![[Demo.mp4]]')).toEqual({ target: 'Demo.mp4', width: undefined })
    expect(parseMediaEmbed('  ![[Dossier/Clip.WEBM|480]]  ')).toEqual({ target: 'Dossier/Clip.WEBM', width: 480 })
    expect(parseMediaEmbed('![[Son.mp3]]')?.target).toBe('Son.mp3')
    expect(parseMediaEmbed('![[Image.png]]')).toBeNull()
    expect(parseMediaEmbed('texte ![[Demo.mp4]]')).toBeNull()
    expect(isMediaPath('a/b.mov')).toBe(true)
    expect(isMediaPath('a/b.md')).toBe(false)
  })

  it('un lecteur video avec les commandes du navigateur, sur la piece jointe', async () => {
    const vault = { resolveAttachmentUrl: vi.fn(async () => 'blob:video') } as unknown as VaultAPI
    globalThis.fetch = vi.fn(async () => ({ blob: async () => new Blob(['x'], { type: 'video/mp4' }) })) as never
    const { el } = createPlayer(vault, 'Demo.mp4', { width: 320 })
    await new Promise(r => setTimeout(r, 0))
    await new Promise(r => setTimeout(r, 0))
    const video = el.querySelector('video')!
    expect(video).not.toBeNull()
    expect(video.controls).toBe(true)
    expect(video.getAttribute('src')).toBe('blob:video')
    expect(video.style.width).toBe('320px')
  })

  it('un son : un lecteur audio', () => {
    const vault = { resolveAttachmentUrl: async () => 'blob:son' } as unknown as VaultAPI
    expect(createPlayer(vault, 'Son.mp3').el.querySelector('audio')).not.toBeNull()
  })

  it('fichier introuvable : un message, pas un lecteur vide', async () => {
    const vault = { resolveAttachmentUrl: async () => { throw new Error('absent') } } as unknown as VaultAPI
    const { el } = createPlayer(vault, 'Manque.mp4')
    await new Promise(r => setTimeout(r, 0))
    expect(el.querySelector('[data-testid="media-error"]')?.textContent).toContain('Manque.mp4')
  })

  it('declare un type de fichier par extension et un bloc d integration', async () => {
    const files: string[] = []
    const blocks: string[] = []
    const api = {
      files: { register: (s: { extension: string }) => files.push(s.extension), unregister: () => {} },
      blocks: { register: (s: { type: string }) => blocks.push(s.type), unregister: () => {} },
    }
    await createVideoPlugin().onload(api as never)
    expect(files).toEqual(expect.arrayContaining(['mp4', 'webm', 'mov', 'mp3']))
    expect(blocks).toEqual(['media-embed'])
  })
})
