// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-chat : les messages vivent dans une carte partagee du document,
// une cle par message. Deux personnes qui ecrivent en meme temps ne
// s'ecrasent pas.
import { describe, it, expect } from 'vitest'
import plugin, { postMessage, readMessages } from '@savoire/plugin-chat'
import type { FileContext, FileTypeSpec, ISharedMap, PluginAPI } from '@savoire/plugin-api'

/** Carte partagee en memoire, partagee entre deux « membres ». */
function memoryMap(): ISharedMap {
  const data = new Map<string, unknown>()
  const listeners = new Set<(keys: string[]) => void>()
  return {
    set(key, value) { data.set(key, value); for (const cb of listeners) cb([key]) },
    delete(key) { data.delete(key); for (const cb of listeners) cb([key]) },
    getAll: () => [...data.entries()].map(([id, value]) => ({ id, value })),
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb) } },
  }
}

async function chatSpec(): Promise<FileTypeSpec> {
  const specs: FileTypeSpec[] = []
  await plugin.onload({ files: { register: (s: FileTypeSpec) => specs.push(s) } } as unknown as PluginAPI)
  return specs[0]
}

function mount(spec: FileTypeSpec, map: ISharedMap, user: string, readOnly = false) {
  const ctx: FileContext = { vaultId: 'v1', path: 'equipe.chat', userId: user, userName: user.toUpperCase(), readOnly, shared: { openMap: () => map } }
  const el = document.createElement('div')
  const view = spec.open!('equipe.chat', ctx)
  view.mount(el)
  return { el, view }
}

function send(el: HTMLElement, text: string) {
  ;(el.querySelector('[data-testid="chat-input"]') as HTMLInputElement).value = text
  el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
}

const texts = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="chat-text"]')).map(n => n.textContent)

describe('plugin-chat', () => {
  it('declare le type .chat, en CRDT, sans verrou', async () => {
    const spec = await chatSpec()
    expect(spec).toMatchObject({ extension: 'chat', collaborationMode: 'crdt' })
  })

  it('les messages de deux membres arrivent chez les deux, dans l\'ordre', async () => {
    const spec = await chatSpec()
    const map = memoryMap()
    const alice = mount(spec, map, 'alice')
    const bob = mount(spec, map, 'bob')
    send(alice.el, 'Bonjour')
    send(bob.el, 'Salut Alice')
    expect(texts(alice.el)).toEqual(['Bonjour', 'Salut Alice'])
    expect(texts(bob.el)).toEqual(['Bonjour', 'Salut Alice'])
  })

  it('deux messages ecrits au meme instant coexistent', () => {
    const map = memoryMap()
    const at = new Date('2026-10-08T10:00:00Z')
    postMessage(map, { id: 'a', name: 'A' }, 'un', at)
    postMessage(map, { id: 'b', name: 'B' }, 'deux', at)
    expect(readMessages(map).map(m => m.text).sort()).toEqual(['deux', 'un'])
  })

  it('un message vide n\'est pas envoye', () => {
    const map = memoryMap()
    expect(postMessage(map, { id: 'a', name: 'A' }, '   ')).toBeNull()
    expect(map.getAll()).toEqual([])
  })

  it('en lecture seule, on lit sans pouvoir ecrire', async () => {
    const spec = await chatSpec()
    const map = memoryMap()
    postMessage(map, { id: 'a', name: 'A' }, 'Lisible')
    const { el } = mount(spec, map, 'bob', true)
    expect(texts(el)).toEqual(['Lisible'])
    expect((el.querySelector('form') as HTMLElement).style.display).toBe('none')
  })

  it('sans vault, la vue le dit au lieu de planter', async () => {
    const spec = await chatSpec()
    const el = document.createElement('div')
    spec.open!('x.chat', { vaultId: 'v1', path: 'x.chat' }).mount(el)
    expect(el.textContent).toContain('vault')
  })
})
