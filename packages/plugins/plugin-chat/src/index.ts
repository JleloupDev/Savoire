// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-chat — des discussions dans le vault, entre ses membres.
//
// Une discussion est un document .chat. Ses messages vivent dans le CRDT du
// document lui-meme (ctx.tree, voir messages.ts) : en direct, sans perte
// quand deux personnes ecrivent en meme temps, avec ou sans serveur. Pas de
// verrou : chacun ecrit quand il veut. Les messages ecrits avant, dans une
// carte du vault a cote du document (ctx.shared), restent lisibles.
//
// Comme dans Teams, un message peut porter un module : une ligne `@[[Note]]`
// (module modifiable, a plusieurs, dans la discussion) ou `![[Note]]` (apercu
// d'une note, d'un board, d'une base, d'une video...). Le rendu est celui des
// notes : le bloc du plugin qui reconnait la ligne. Le bouton « Module » du
// champ de saisie en choisit un dans le vault.

import { BLOCK_DESTROY_EVENT, createIcon } from '@savoire/plugin-api'
import type { FileContext, FileView, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { mergedMessageMap, postMessage, readMessages, treeMessageMap, type ChatMessage } from './messages'

export { postMessage, readMessages, treeMessageMap, mergedMessageMap, type ChatMessage } from './messages'

const MUTED = 'font-size:12px;color:var(--text-muted,#a6adc8)'

function createChatView(path: string, ctx: FileContext, api?: PluginAPI): FileView {
  const icons = api?.icons
  let container: HTMLElement | null = null
  let unsub: (() => void) | null = null
  let readOnly = !!ctx.readOnly
  const me = { id: ctx.userId ?? 'anonyme', name: ctx.userName ?? ctx.userId ?? 'Anonyme' }
  const legacy = ctx.shared?.openMap('messages')
  const inDoc = ctx.tree ? treeMessageMap(ctx.tree) : undefined
  const map = inDoc && legacy ? mergedMessageMap(inDoc, legacy) : inDoc ?? legacy

  /** Lignes deja affichees, par message : un nouveau message ne redessine pas les autres (un module garde son etat). */
  const rows = new Map<string, { el: HTMLElement; key: string }>()

  function dropRow(id: string): void {
    const row = rows.get(id)
    if (!row) return
    row.el.querySelectorAll('[data-chat-embed]').forEach(e => e.firstElementChild?.dispatchEvent(new CustomEvent(BLOCK_DESTROY_EVENT)))
    row.el.remove()
    rows.delete(id)
  }

  function render(): void {
    if (!container) return
    const list = container.querySelector<HTMLElement>('[data-testid="chat-messages"]')
    if (!list || !map) return
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    const messages = readMessages(map)
    const ids = new Set(messages.map(m => m.id))
    for (const id of [...rows.keys()]) if (!ids.has(id)) dropRow(id)
    list.querySelector('[data-testid="chat-empty"]')?.remove()
    let previous: Element | null = null
    for (const m of messages) {
      const key = `${m.author.id}|${m.at}|${m.text}`
      let row = rows.get(m.id)
      if (row && row.key !== key) { dropRow(m.id); row = undefined }
      if (!row) { row = { el: messageRow(m), key }; rows.set(m.id, row) }
      const next: Element | null = previous ? previous.nextElementSibling : list.firstElementChild
      if (next !== row.el) list.insertBefore(row.el, next)
      previous = row.el
    }
    if (messages.length === 0) {
      const empty = document.createElement('div')
      empty.dataset.testid = 'chat-empty'
      empty.style.cssText = MUTED
      empty.textContent = 'Aucun message. Lancez la discussion !'
      list.appendChild(empty)
    }
    if (atBottom) list.scrollTop = list.scrollHeight
    const form = container.querySelector<HTMLElement>('form')
    if (form) form.style.display = readOnly ? 'none' : 'flex'
  }

  /** Un module ou une integration (ligne seule `@[[...]]`, `![[...]]`), rendu par le plugin qui la reconnait. */
  function embedOf(line: string): HTMLElement | null {
    if (!api?.blocks || !/^\s*[@!]\[\[[^\]]+\]\]\s*$/.test(line)) return null
    const found = api.blocks.detectBlock(line.trim())
    if (!found) return null
    try {
      const el = found.spec.renderClient(found.spec.deserialize(line.trim()), { editorView: null })
      const box = document.createElement('div')
      box.dataset.chatEmbed = found.type
      box.dataset.testid = 'chat-embed'
      box.style.cssText = 'margin-top:6px;min-width:260px;max-width:100%'
      box.appendChild(el)
      return box
    } catch {
      return null
    }
  }

  function messageRow(m: ChatMessage): HTMLElement {
    const row = document.createElement('div')
    row.dataset.testid = 'chat-message'
    const mine = m.author.id === me.id
    row.style.cssText = `align-self:${mine ? 'flex-end' : 'flex-start'};max-width:75%;padding:6px 10px;border-radius:10px;`
      + `background:${mine ? 'var(--accent-dim,rgba(13,148,136,0.15))' : 'var(--bg-elevated,#313244)'}`
    const head = document.createElement('div')
    head.style.cssText = MUTED
    head.textContent = `${m.author.name} · ${new Date(m.at).toLocaleTimeString()}`
    row.append(head)
    // Le texte, ligne a ligne ; une ligne qui est un module devient le module.
    let text: string[] = []
    const flush = () => {
      if (text.length === 0) return
      const body = document.createElement('div')
      body.dataset.testid = 'chat-text'
      body.style.cssText = 'font-size:14px;white-space:pre-wrap;color:var(--text,#cdd6f4)'
      body.textContent = text.join('\n')
      row.append(body)
      text = []
    }
    for (const line of m.text.split('\n')) {
      const embed = embedOf(line)
      if (embed) { flush(); row.append(embed); if (embed) row.style.maxWidth = '90%' }
      else text.push(line)
    }
    flush()
    return row
  }

  /** Choisir un fichier du vault a integrer : `@[[chemin]]` est envoye comme message. */
  async function openPicker(form: HTMLElement, input: HTMLInputElement): Promise<void> {
    if (!api || !map || readOnly) return
    container?.querySelector('[data-testid="chat-module-picker"]')?.remove()
    const files = (await listAll(api)).filter(f => f !== path && !f.startsWith('.trash/'))
    const box = document.createElement('div')
    box.dataset.testid = 'chat-module-picker'
    box.style.cssText = 'margin:0 16px 8px;padding:8px;border:1px solid var(--border,#313244);border-radius:8px;background:var(--bg-elevated,#1e1e2e);display:flex;flex-direction:column;gap:6px;max-height:260px'
    const search = document.createElement('input')
    search.placeholder = 'Chercher une note, un board, une base…'
    search.dataset.testid = 'chat-module-search'
    search.style.cssText = 'padding:6px 8px;border-radius:6px;border:1px solid var(--border,#313244);background:transparent;color:inherit;font:inherit'
    const results = document.createElement('div')
    results.style.cssText = 'overflow-y:auto;display:flex;flex-direction:column'
    const show = () => {
      const q = search.value.trim().toLowerCase()
      results.replaceChildren(...files.filter(f => !q || f.toLowerCase().includes(q)).slice(0, 50).map(f => {
        const b = document.createElement('button')
        b.type = 'button'
        b.dataset.testid = 'chat-module-choice'
        b.dataset.path = f
        b.textContent = f
        b.style.cssText = 'text-align:left;padding:5px 8px;border:none;border-radius:4px;background:transparent;color:inherit;cursor:pointer;font:inherit'
        b.addEventListener('mouseenter', () => { b.style.background = 'var(--bg-surface,#313244)' })
        b.addEventListener('mouseleave', () => { b.style.background = 'transparent' })
        b.addEventListener('click', () => {
          const extra = input.value.trim()
          postMessage(map, me, `${extra ? extra + '\n' : ''}@[[${f}]]`)
          input.value = ''
          box.remove()
        })
        return b
      }))
    }
    search.addEventListener('input', show)
    search.addEventListener('keydown', e => { if (e.key === 'Escape') box.remove() })
    box.append(search, results)
    form.before(box)
    show()
    search.focus()
  }

  return {
    mount(el: HTMLElement) {
      container = el
      el.style.cssText = 'height:100%;display:flex;flex-direction:column;font-family:var(--font-ui,sans-serif)'
      if (!map) {
        el.textContent = 'La discussion demande un vault ouvert.'
        return
      }
      const title = document.createElement('div')
      title.style.cssText = 'padding:10px 16px;font-weight:600;border-bottom:1px solid var(--border,#313244);color:var(--text,#cdd6f4);display:flex;align-items:center;gap:8px'
      title.append(createIcon(icons, 'messages-square', { size: 16 }), path.split('/').at(-1)?.replace(/\.chat$/, '') ?? path)
      const list = document.createElement('div')
      list.dataset.testid = 'chat-messages'
      list.style.cssText = 'flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px'
      const form = document.createElement('form')
      form.style.cssText = 'display:flex;gap:8px;padding:10px 16px;border-top:1px solid var(--border,#313244)'
      const input = document.createElement('input')
      input.dataset.testid = 'chat-input'
      input.placeholder = 'Écrire un message…'
      input.style.cssText = 'flex:1;min-width:0;padding:7px 10px;border-radius:6px;border:1px solid var(--border,#313244);background:transparent;color:inherit;font:inherit'
      const send = document.createElement('button')
      send.type = 'submit'
      send.dataset.testid = 'chat-send'
      send.textContent = 'Envoyer'
      send.style.cssText = 'padding:7px 14px;border-radius:6px;border:none;background:var(--accent,#0d9488);color:white;font-weight:600;cursor:pointer'
      const pick = document.createElement('button')
      pick.type = 'button'
      pick.dataset.testid = 'chat-module'
      pick.title = 'Intégrer un module : une note, un board, une base... modifiable dans la discussion'
      pick.style.cssText = 'padding:7px 10px;border-radius:6px;border:1px solid var(--border,#313244);background:transparent;color:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:6px'
      pick.append(createIcon(icons, 'box', { size: 14 }), 'Module')
      pick.addEventListener('click', () => void openPicker(form, input))
      if (api?.vault) form.append(pick)
      form.append(input, send)
      form.addEventListener('submit', (e) => {
        e.preventDefault()
        if (readOnly) return
        if (postMessage(map, me, input.value)) input.value = ''
        input.focus()
      })
      el.replaceChildren(title, list, form)
      unsub = map.onChange(() => render())
      render()
      list.scrollTop = list.scrollHeight
    },

    setReadOnly(next: boolean) {
      readOnly = next
      render()
    },

    destroy() {
      unsub?.(); unsub = null
      for (const id of [...rows.keys()]) dropRow(id)
      container?.replaceChildren()
      container = null
    },
  }
}

const plugin: VaultPlugin = {
  manifest: {
    id: 'plugin-chat',
    name: 'Discussions',
    version: '0.0.1',
    description: 'Des discussions en direct entre les membres du vault (fichiers .chat)',
    scope: 'vault',
    permissions: ['ui:editor', 'vault:read'],
  },

  async onload(api: PluginAPI) {
    api.files.register({
      extension: 'chat',
      label: 'Discussion',
      icon: 'messages-square',
      // Les messages vivent dans le CRDT du document : edition simultanee, sans verrou.
      collaborationMode: 'crdt',
      // Contenu : un arbre (ctx.tree). Sur le disque : son JSON.
      crdtRoot: 'tree',
      create: async () => '',
      open: (path: string, ctx: FileContext) => createChatView(path, ctx, api),
    })
  },

  async onunload() {},
}

/** Tous les fichiers du vault (pour choisir un module). */
async function listAll(api: PluginAPI): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length && files.length < 20_000) {
    const dir = queue.shift()!
    for (const entry of await api.vault.list(dir || undefined).catch(() => [] as string[])) {
      if (entry.endsWith('/')) { if (entry !== dir) queue.push(entry) }
      else files.push(entry)
    }
  }
  return files.sort((a, b) => a.localeCompare(b))
}

export default plugin
