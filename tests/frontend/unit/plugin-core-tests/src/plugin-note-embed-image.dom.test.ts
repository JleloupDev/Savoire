// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Images integrees, comme Obsidian : taille `|300` / `|300x200`, texte
// alternatif, jamais de deformation, poignee qui ecrit `|<largeur>`.
import { describe, it, expect, vi } from 'vitest'
import { parseImageEmbed, withImageWidth, renderImageEmbed } from '@savoire/plugin-note-embed'
import type { BlockContext, VaultAPI } from '@savoire/plugin-api'

const tick = () => new Promise(r => setTimeout(r, 0))

function vault(urls: Record<string, string>): VaultAPI {
  return {
    resolveAttachmentUrl: vi.fn(async (p: string) => {
      if (p in urls) return urls[p]
      throw new Error('introuvable')
    }),
  } as unknown as VaultAPI
}

describe('analyse de ![[image.png|...]]', () => {
  it('largeur seule', () => {
    const e = parseImageEmbed('image.png|300')
    expect([e.target, e.width, e.height]).toEqual(['image.png', 300, undefined])
  })
  it('boite largeur x hauteur', () => {
    expect(parseImageEmbed('dossier/image.png|300x200')).toMatchObject({ target: 'dossier/image.png', width: 300, height: 200 })
  })
  it('un parametre qui n\'est pas un nombre est le texte alternatif', () => {
    const e = parseImageEmbed('image.png|Mon chat')
    expect([e.alt, e.width]).toEqual(['Mon chat', undefined])
    expect(parseImageEmbed('image.png|Mon chat|120')).toMatchObject({ alt: 'Mon chat', width: 120 })
  })
  it('redimensionner remplace la taille et garde le reste', () => {
    expect(withImageWidth('image.png', 240.4)).toBe('image.png|240')
    expect(withImageWidth('image.png|300x200', 150)).toBe('image.png|150')
    expect(withImageWidth('image.png|Mon chat|300', 90)).toBe('image.png|Mon chat|90')
  })
})

describe('rendu', () => {
  const ctx: BlockContext = { editorView: null }

  it('largeur seule : hauteur auto, ratio garde', async () => {
    const el = renderImageEmbed('a.png|300', vault({ 'a.png': 'blob:a' }), ctx)
    const img = el.querySelector('img')!
    expect(img.style.width).toBe('300px')
    expect(img.style.height).toBe('auto')
    expect(img.style.maxWidth).toBe('100%')
    await tick()
    expect(img.getAttribute('src')).toBe('blob:a')
  })

  it('boite : object-fit contain, jamais deformee', () => {
    const img = renderImageEmbed('a.png|300x200', vault({}), ctx).querySelector('img')!
    expect(img.style.width).toBe('300px')
    expect(img.style.height).toBe('200px')
    expect(img.style.objectFit).toBe('contain')
  })

  it('sans taille : naturelle, bornee a la largeur', () => {
    const img = renderImageEmbed('a.png', vault({}), ctx).querySelector('img')!
    expect(img.style.width).toBe('')
    expect(img.style.height).toBe('auto')
    expect(img.style.maxWidth).toBe('100%')
  })

  it('texte alternatif', () => {
    expect(renderImageEmbed('a.png|Mon chat', vault({}), ctx).querySelector('img')!.alt).toBe('Mon chat')
  })

  it('image introuvable : un message, pas une image cassee', async () => {
    const el = renderImageEmbed('absente.png', vault({}), ctx)
    await tick(); await tick()
    expect(el.textContent).toContain('Image introuvable')
  })
})

describe('poignee de redimensionnement', () => {
  it('absente si l\'editeur ne permet pas d\'ecrire', () => {
    expect(renderImageEmbed('a.png', vault({}), { editorView: null }).querySelector('.note-embed-resize')).toBeNull()
  })

  it('glisser le coin ecrit |<largeur> dans la ligne', () => {
    const edit = vi.fn()
    const line = { from: 10, to: 22, text: '![[a.png]]' }
    const el = renderImageEmbed('a.png', vault({}), { editorView: null, edit, locate: () => line })
    document.body.appendChild(el)
    const img = el.querySelector('img')!
    img.getBoundingClientRect = () => ({ width: 200 } as DOMRect)
    const handle = el.querySelector('.note-embed-resize')!
    handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 160 }))
    expect(img.style.width).toBe('260px')
    expect(img.style.height).toBe('auto')
    window.dispatchEvent(new MouseEvent('mouseup', {}))
    expect(edit).toHaveBeenCalledWith(10, 22, '![[a.png|260]]')
    el.remove()
  })
})
