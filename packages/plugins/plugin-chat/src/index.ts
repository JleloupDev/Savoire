// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-chat — des discussions dans le vault, entre ses membres.
//
// Une discussion est un document .chat. Ses messages vivent dans une carte
// partagee du document (ctx.shared), un CRDT ouvert par la session du vault :
// en direct, sans perte quand deux personnes ecrivent en meme temps, avec ou
// sans serveur. Pas de verrou : chacun ecrit quand il veut.

import type { FileContext, FileView, PluginAPI, VaultPlugin } from '@savoire/plugin-api'
import { postMessage, readMessages, type ChatMessage } from './messages'

export { postMessage, readMessages, type ChatMessage } from './messages'

const MUTED = 'font-size:12px;color:var(--text-muted,#a6adc8)'

function createChatView(path: string, ctx: FileContext): FileView {
  let container: HTMLElement | null = null
  let unsub: (() => void) | null = null
  let readOnly = !!ctx.readOnly
  const me = { id: ctx.userId ?? 'anonyme', name: ctx.userName ?? ctx.userId ?? 'Anonyme' }
  const map = ctx.shared?.openMap('messages')

  function render(): void {
    if (!container) return
    const list = container.querySelector<HTMLElement>('[data-testid="chat-messages"]')
    if (!list || !map) return
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40
    list.replaceChildren(...readMessages(map).map(messageRow))
    if (list.childElementCount === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = MUTED
      empty.textContent = 'Aucun message. Lancez la discussion !'
      list.appendChild(empty)
    }
    if (atBottom) list.scrollTop = list.scrollHeight
    const form = container.querySelector<HTMLElement>('form')
    if (form) form.style.display = readOnly ? 'none' : 'flex'
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
    const body = document.createElement('div')
    body.dataset.testid = 'chat-text'
    body.style.cssText = 'font-size:14px;white-space:pre-wrap;color:var(--text,#cdd6f4)'
    body.textContent = m.text
    row.append(head, body)
    return row
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
      title.style.cssText = 'padding:10px 16px;font-weight:600;border-bottom:1px solid var(--border,#313244);color:var(--text,#cdd6f4)'
      title.textContent = `💬 ${path.split('/').at(-1)?.replace(/\.chat$/, '') ?? path}`
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
    permissions: ['ui:editor'],
  },

  async onload(api: PluginAPI) {
    api.files.register({
      extension: 'chat',
      label: 'Discussion',
      icon: '💬',
      // Les messages vivent dans une carte CRDT : edition simultanee, sans verrou.
      collaborationMode: 'crdt',
      create: async () => '',
      open: (path: string, ctx: FileContext) => createChatView(path, ctx),
    })
  },

  async onunload() {},
}

export default plugin
