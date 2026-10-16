// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Images integrees `![[image.png|...]]`, comme Obsidian :
//   ![[image.png|300]]      largeur 300 px, hauteur proportionnelle
//   ![[image.png|300x200]]  boite 300 x 200, image contenue dedans
//   ![[image.png|legende]]  texte alternatif
// L'image n'est JAMAIS deformee : `height:auto` quand seule la largeur est
// donnee, `object-fit: contain` dans une boite. Une poignee (coin bas-droit)
// redimensionne a la souris et ecrit `|<largeur>` dans le texte.
import type { BlockContext, VaultAPI } from '@savoire/plugin-api'

export interface ImageEmbed {
  target: string
  width?: number
  height?: number
  alt?: string
  /** Parametres tels qu'ecrits apres la cible (pour les reecrire sans rien perdre). */
  params: string[]
}

const SIZE_RE = /^(\d+)(?:\s*x\s*(\d+))?$/

/** Analyse le contenu de `![[...]]` : cible, taille, texte alternatif. */
export function parseImageEmbed(raw: string): ImageEmbed {
  const [first, ...params] = raw.split('|').map(p => p.trim())
  const embed: ImageEmbed = { target: (first ?? '').split('#', 1)[0].trim(), params }
  for (const p of params) {
    const size = SIZE_RE.exec(p)
    if (size) {
      embed.width = Number(size[1])
      if (size[2]) embed.height = Number(size[2])
    } else if (p && embed.alt === undefined) {
      embed.alt = p
    }
  }
  return embed
}

/** Contenu de `![[...]]` avec une nouvelle largeur (la hauteur suit le ratio). */
export function withImageWidth(raw: string, width: number): string {
  const [first, ...params] = raw.split('|')
  const kept = params.filter(p => !SIZE_RE.test(p.trim()))
  return [first, ...kept, String(Math.round(width))].join('|')
}

/** Taille appliquee a l'image : jamais de deformation. */
export function applyImageSize(img: HTMLImageElement, embed: Pick<ImageEmbed, 'width' | 'height'>): void {
  const s = img.style
  s.maxWidth = '100%'
  s.width = embed.width ? `${embed.width}px` : ''
  s.height = embed.width && embed.height ? `${embed.height}px` : 'auto'
  s.objectFit = embed.width && embed.height ? 'contain' : ''
}

const EMBED_IN_LINE_RE = /!\[\[([^\]]+)\]\]/

/** Rendu d'une image integree, avec sa poignee de redimensionnement. */
export function renderImageEmbed(raw: string, vault: VaultAPI, ctx: BlockContext): HTMLElement {
  const embed = parseImageEmbed(raw)
  const block = document.createElement('div')
  block.className = 'note-embed-image'
  block.style.cssText = 'margin:4px 0;line-height:0'

  const frame = document.createElement('span')
  frame.style.cssText = 'position:relative;display:inline-block;max-width:100%'
  block.appendChild(frame)

  const img = document.createElement('img')
  img.alt = embed.alt ?? embed.target.split('/').at(-1) ?? embed.target
  img.draggable = false
  img.style.cssText = 'display:block;border-radius:4px'
  applyImageSize(img, embed)
  frame.appendChild(img)

  const fail = (): void => {
    const err = document.createElement('span')
    err.className = 'note-embed-image-error'
    err.style.cssText = 'font-size:12px;line-height:1.5;color:var(--text-muted,#888)'
    err.textContent = `⚠ Image introuvable : ${embed.target}`
    frame.replaceChildren(err)
  }
  const url = vault.resolveAttachmentUrl?.(embed.target)
  if (url) url.then(u => { img.src = u }, fail)
  else fail()

  if (ctx.locate && ctx.edit) frame.appendChild(resizeHandle(block, img, raw, embed, ctx))
  return block
}

function resizeHandle(block: HTMLElement, img: HTMLImageElement, raw: string, embed: ImageEmbed, ctx: BlockContext): HTMLElement {
  const handle = document.createElement('span')
  handle.className = 'note-embed-resize'
  handle.title = 'Redimensionner'
  handle.style.cssText = [
    'position:absolute', 'right:2px', 'bottom:2px', 'width:12px', 'height:12px',
    'cursor:nwse-resize', 'border-right:3px solid var(--accent,#7c3aed)',
    'border-bottom:3px solid var(--accent,#7c3aed)', 'border-radius:0 0 3px 0',
    'opacity:0', 'transition:opacity .15s',
  ].join(';')
  const frame = img.parentElement!
  frame.addEventListener('mouseenter', () => { handle.style.opacity = '0.9' })
  frame.addEventListener('mouseleave', () => { handle.style.opacity = '0' })

  handle.addEventListener('mousedown', (down: MouseEvent) => {
    // L'editeur ne doit pas prendre ce clic (il passerait la ligne en texte brut).
    down.preventDefault()
    down.stopPropagation()
    const startX = down.clientX
    const startWidth = img.getBoundingClientRect().width
    let width: number | undefined

    const move = (ev: MouseEvent): void => {
      width = Math.max(32, Math.round(startWidth + ev.clientX - startX))
      // Largeur seule : la hauteur suit, le ratio est garde.
      applyImageSize(img, { width })
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (width === undefined) return
      const line = ctx.locate?.(block)
      const m = line ? EMBED_IN_LINE_RE.exec(line.text) : null
      if (!line || !m) { applyImageSize(img, embed); return }
      const text = line.text.replace(EMBED_IN_LINE_RE, `![[${withImageWidth(m[1] ?? raw, width)}]]`)
      if (text !== line.text) ctx.edit?.(line.from, line.to, text)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
  return handle
}
