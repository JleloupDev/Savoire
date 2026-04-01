// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI } from '@savoire/plugin-api'
import { marked } from 'marked'

// Détecte les listes Markdown bullet ou ordonnées
const LIST_RE = /^(\s*[-*+]|\s*\d+\.) /m

// Symboles de puce par niveau de profondeur (Catppuccin Mauve)
const BULLETS = ['•', '◦', '▸', '–']
const BULLET_COLOR = '#7c3aed'

interface ListData { markdown: string }

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

      renderClient: (data, _ctx) => {
        const { markdown } = data as ListData
        const html = String(marked.parse(markdown))

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
