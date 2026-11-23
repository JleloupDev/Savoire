// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { sanitizeHtml } from '@savoire/plugin-api'
import type { VaultPlugin, PluginAPI, BlockLine, BlockLineMarker, BlockContext } from '@savoire/plugin-api'
import { marked } from 'marked'
import { taskAgentTools } from './agentTools'
import { itemLineAt, moveListItem, type ListEditor } from './moveItem'

export { taskAgentTools, parseTasks, addTask, setTaskDone } from './agentTools'

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
  // A droite, la marge d'une ligne brute (2px) : la ligne coupe au meme endroit en edition.
  // L'interligne est celui du theme (--vault-line-height), comme la ligne brute.
  div.style.cssText = 'position:relative;margin:0;padding:0 2px 0 4px;line-height:var(--vault-line-height, 1.65)'
  const m = ITEM_RE.exec(line.text)
  // Memes retraits que le bloc entier : liste a 2em par niveau, texte a
  // 1.4em de la puce. Une suite d'element s'aligne sur le texte.
  div.style.paddingLeft = `${2 * line.depth + 3.4}em`
  if (!m) {
    div.innerHTML = sanitizeHtml(inline(line.text.trim()))
    return div
  }
  const [, , marker, , task, body] = m
  const content = document.createElement('span')
  content.innerHTML = sanitizeHtml(inline(body))

  if (task !== undefined) {
    if (task !== ' ') content.style.opacity = '0.6'
    // La suite d'un texte trop long passe sous le texte, pas sous la case.
    div.style.paddingLeft = `calc(${2 * line.depth + 3.4}em + ${TASK_BOX_WIDTH})`
    div.style.textIndent = `calc(-1 * ${TASK_BOX_WIDTH})`
    div.append(taskBox(m, line, ctx), content)
    return div
  }

  // Le retrait est porte par un conteneur a la taille du texte : un « em »
  // mesure dans la puce, plus petite, ne tomberait pas au meme endroit.
  const bullet = document.createElement('span')
  bullet.style.cssText = `position:absolute;left:${bulletLeft(marker, line.depth)}em;user-select:none`
  bullet.appendChild(bulletGlyph(marker, line.depth))
  div.append(bullet, content)
  return div
}

/** Place prise par la case a cocher : 4px + 13px + 5px. */
const TASK_BOX_WIDTH = '22px'

/** La puce part de la, le texte de 2 * profondeur + 3.4 em. */
const bulletLeft = (marker: string, depth: number): number => 2 * depth + (/\d/.test(marker) ? 1.6 : 2)

function bulletGlyph(marker: string, depth: number): HTMLElement {
  const glyph = document.createElement('span')
  glyph.style.cssText = `color:${BULLET_COLOR};font-size:${depth === 0 ? '14px' : '11px'}`
  glyph.textContent = BULLETS[depth % BULLETS.length]
  if (/\d/.test(marker)) {
    // Liste numerotee : le numero ecrit, pas une puce.
    glyph.textContent = marker
    glyph.style.fontSize = 'inherit'
  }
  return glyph
}

function taskBox(m: RegExpExecArray, line: BlockLine, ctx: BlockContext): HTMLInputElement {
  const [, indent, marker, space, task] = m
  const checked = task !== ' '
  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = checked
  cb.disabled = !ctx.edit
  // Largeur fixe (TASK_BOX_WIDTH, marges comprises) : le retrait suspendu en depend.
  cb.style.cssText = 'width:13px;height:13px;margin:3px 5px 3px 4px;vertical-align:middle;accent-color:#7c3aed;cursor:pointer'
  const at = line.from + indent.length + marker.length + space.length + 1
  // mousedown arrete : le clic coche sans faire passer la ligne en edition.
  cb.addEventListener('mousedown', e => {
    e.preventDefault()
    e.stopPropagation()
    ctx.edit?.(at, at + 1, checked ? ' ' : 'x')
  })
  return cb
}

/**
 * Le marqueur de la ligne en edition : la puce (ou la case) a la place du
 * `- ` brut, la ou le rendu la met. Le texte ne bouge pas.
 */
function listLineMarker(line: BlockLine, ctx: BlockContext): BlockLineMarker | null {
  const m = ITEM_RE.exec(line.text)
  if (!m) return null
  const [, , marker, , task] = m
  if (task !== undefined) return { indent: `${2 * line.depth + 3.4}em`, el: taskBox(m, line, ctx), width: TASK_BOX_WIDTH }
  const left = bulletLeft(marker, line.depth)
  const width = `${2 * line.depth + 3.4 - left}em`
  const box = document.createElement('span')
  box.style.cssText = `display:inline-block;width:${width};text-indent:0;user-select:none`
  box.appendChild(bulletGlyph(marker, line.depth))
  return { indent: `${left}em`, el: box, width }
}

function enhanceList(ul: HTMLElement, depth: number): void {
  ul.style.cssText = 'padding-left:2em;margin:0;list-style:none'

  for (const child of Array.from(ul.children)) {
    if (child.tagName !== 'LI') continue
    const li = child as HTMLElement
    li.style.cssText = 'position:relative;padding-left:1.4em;margin:0;line-height:var(--vault-line-height, 1.65)'
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
    permissions: ['ui:editor', 'vault:read', 'vault:write', 'agents'],
    defaultActive: true,
    // Livre avec Savoire : ses outils d'agent tournent aussi sur le pair indexeur.
    official: true,
  },

  async onload(api: PluginAPI) {
    // Agents (ADR-033) : lister, ajouter, cocher des taches.
    for (const tool of taskAgentTools(api)) api.agents?.registerTool(tool)
    // Alt+↑ / Alt+↓ : l'element de liste se deplace avec ses sous-elements.
    // Hors d'une liste, la touche revient au deplacement de ligne de l'editeur.
    const editorOf = (ctx: { editorView: unknown }) => ctx.editorView as ListEditor | null
    for (const [id, label, key, dir] of [
      ['list:move-item-up', 'Monter l\'élément de liste (avec ses sous-éléments)', 'ArrowUp', -1],
      ['list:move-item-down', 'Descendre l\'élément de liste (avec ses sous-éléments)', 'ArrowDown', 1],
    ] as const) {
      api.commands.register({
        id, label, editor: true,
        hotkeys: [{ modifiers: ['Alt'], key }],
        isAvailable: ctx => { const ed = editorOf(ctx); return !!ed && itemLineAt(ed) !== null },
        run: ctx => { const ed = editorOf(ctx); if (ed) moveListItem(ed, dir) },
      })
    }
    api.blocks.register({
      type: 'task-list',

      detect: (text) => LIST_RE.test(text),

      deserialize: (raw) => ({ markdown: String(raw) }),

      serialize: (data) => (data as ListData).markdown,

      createEditorWidget: (_data, _ctx) => ({ mount: (_el) => {}, destroy: () => {} }),

      // Les hooks (liens [[...]]) passent avant le rendu, comme pour le texte.
      renderLine: (line, ctx) =>
        renderListLine(line, ctx, md => String(marked.parseInline(api.hooks.runBeforeParseSync(md)))),

      renderLineMarker: listLineMarker,

      renderClient: (data, _ctx) => {
        const { markdown } = data as ListData
        // breaks : meme rendu des retours a la ligne que dans l'editeur.
        const html = String(marked.parse(markdown, { breaks: true }))

        const wrapper = document.createElement('div')
        wrapper.className = 'vault-rendered-block'
        wrapper.innerHTML = sanitizeHtml(html)

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
