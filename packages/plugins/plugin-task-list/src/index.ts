// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI, BlockLine, BlockContext } from '@savoire/plugin-api'
import { marked } from 'marked'

// Détecte les listes Markdown bullet ou ordonnées
const LIST_RE = /^(\s*[-*+]|\s*\d+\.) /m

// Symboles de puce par niveau de profondeur (Catppuccin Mauve)
const BULLETS = ['•', '◦', '▸', '–']
const BULLET_COLOR = '#7c3aed'

interface ListData { markdown: string }

const ITEM_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(?:\[([ xX])\]\s+)?(.*)$/

/**
 * Rendu d'UNE ligne de liste, comme dans Obsidian : l'editeur rend chaque
 * ligne a part et seule celle du curseur passe en edition. Meme apparence
 * que le rendu du bloc entier ; la case a cocher se coche d'un clic.
 */
function renderListLine(line: BlockLine, ctx: BlockContext, inline: (md: string) => string): HTMLElement {
  const div = document.createElement('div')
  div.className = 'vault-rendered-block'
  div.style.cssText = 'position:relative;margin:0;padding:0.075em 4px;line-height:1.5'
  const m = ITEM_RE.exec(line.text)
  // Memes retraits que le bloc entier : liste a 2em par niveau, texte a
  // 1.4em de la puce. Une suite d'element s'aligne sur le texte.
  div.style.paddingLeft = `${2 * line.depth + 3.4}em`
  if (!m) {
    div.innerHTML = inline(line.text.trim())
    return div
  }
  const [, indent, marker, space, task, body] = m
  const content = document.createElement('span')
  content.innerHTML = inline(body)

  if (task !== undefined) {
    const checked = task !== ' '
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = checked
    cb.disabled = !ctx.edit
    cb.style.cssText = 'margin-right:5px;vertical-align:middle;accent-color:#7c3aed;cursor:pointer'
    const at = line.from + indent.length + marker.length + space.length + 1
    // mousedown arrete : le clic coche sans faire passer la ligne en edition.
    cb.addEventListener('mousedown', e => {
      e.preventDefault()
      e.stopPropagation()
      ctx.edit?.(at, at + 1, checked ? ' ' : 'x')
    })
    if (checked) content.style.opacity = '0.6'
    div.append(cb, content)
    return div
  }

  // Le retrait est porte par un conteneur a la taille du texte : un « em »
  // mesure dans la puce, plus petite, ne tomberait pas au meme endroit.
  const bullet = document.createElement('span')
  bullet.style.cssText = `position:absolute;left:${2 * line.depth + 2}em;user-select:none`
  const glyph = document.createElement('span')
  glyph.style.cssText = `color:${BULLET_COLOR};font-size:${line.depth === 0 ? '14px' : '11px'}`
  glyph.textContent = BULLETS[line.depth % BULLETS.length]
  if (/\d/.test(marker)) {
    // Liste numerotee : le numero ecrit, pas une puce.
    glyph.textContent = marker
    glyph.style.fontSize = 'inherit'
    bullet.style.left = `${2 * line.depth + 1.6}em`
  }
  bullet.appendChild(glyph)
  div.append(bullet, content)
  return div
}

function enhanceList(ul: HTMLElement, depth: number): void {
  ul.style.cssText = 'padding-left:2em;margin:0;list-style:none'

  for (const child of Array.from(ul.children)) {
    if (child.tagName !== 'LI') continue
    const li = child as HTMLElement
    li.style.cssText = 'position:relative;padding-left:1.4em;padding-top:0.075em;padding-bottom:0.075em;margin:0;line-height:1.5'
    // marked wraps loose-list items in <p> — strip browser default margins.
    for (const child of Array.from(li.children)) {
      if (child.tagName === 'P') (child as HTMLElement).style.margin = '0'
    }

    // Recherche du premier nœud texte pour détecter [ ] / [x]
    const firstChild = li.firstChild
    if (firstChild?.nodeType === Node.TEXT_NODE) {
      const txt = firstChild.textContent ?? ''
      if (/^\[[ xX]\] /.test(txt)) {
        const checked = /^\[[xX]\] /.test(txt)
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = checked
        cb.disabled = true  // read-only dans le viewer
        cb.style.cssText = 'margin-right:5px;vertical-align:middle;accent-color:#7c3aed'
        firstChild.textContent = txt.replace(/^\[[ xX]\] /, '')
        li.insertBefore(cb, li.firstChild)
        if (checked) li.style.opacity = '0.6'
        // Récurse dans les sous-listes
        for (const nested of Array.from(li.children)) {
          if (nested.tagName === 'UL' || nested.tagName === 'OL') {
            enhanceList(nested as HTMLElement, depth + 1)
          }
        }
        continue
      }
    }

    // Puce visuelle par profondeur
    const bullet = document.createElement('span')
    bullet.style.cssText =
      `position:absolute;left:0;color:${BULLET_COLOR};` +
      `user-select:none;font-size:${depth === 0 ? '14px' : '11px'}`
    bullet.textContent = BULLETS[depth % BULLETS.length]
    li.insertBefore(bullet, li.firstChild)

    // Récurse dans les sous-listes
    for (const nested of Array.from(li.children)) {
      if (nested.tagName === 'UL' || nested.tagName === 'OL') {
        enhanceList(nested as HTMLElement, depth + 1)
      }
    }
  }
}

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-task-list',
    scope: 'personal',
    name: 'Task & Multi-level Lists',
    version: '1.0.0',
    permissions: ['ui:editor'],
    defaultActive: true,
  },

  async onload(api: PluginAPI) {
    api.blocks.register({
      type: 'task-list',

      detect: (text) => LIST_RE.test(text),

      deserialize: (raw) => ({ markdown: String(raw) }),

      serialize: (data) => (data as ListData).markdown,

      createEditorWidget: (_data, _ctx) => ({ mount: (_el) => {}, destroy: () => {} }),

      // Les hooks (liens [[...]]) passent avant le rendu, comme pour le texte.
      renderLine: (line, ctx) =>
        renderListLine(line, ctx, md => String(marked.parseInline(api.hooks.runBeforeParseSync(md)))),

      renderClient: (data, _ctx) => {
        const { markdown } = data as ListData
        // breaks : meme rendu des retours a la ligne que dans l'editeur.
        const html = String(marked.parse(markdown, { breaks: true }))

        const wrapper = document.createElement('div')
        wrapper.className = 'vault-rendered-block'
        wrapper.innerHTML = html

        // Améliore toutes les listes de premier niveau
        for (const list of Array.from(wrapper.children)) {
          if (list.tagName === 'UL' || list.tagName === 'OL') {
            enhanceList(list as HTMLElement, 0)
          }
        }

        return wrapper
      },
    })
  },

  async onunload() {},
}

export default plugin
