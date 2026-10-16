// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// plugin-chat : les messages vivent dans le CRDT du document (ctx.tree),
// une cle par message. Les anciens messages (carte du vault) restent lisibles.
import { describe, it, expect } from 'vitest'
import plugin, { postMessage, readMessages, treeMessageMap } from '@savoire/plugin-chat'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { FileContext, FileTypeSpec, ISharedMap, ISharedTree, PluginAPI } from '@savoire/plugin-api'

async function chatSpec(): Promise<FileTypeSpec> {
  const specs: FileTypeSpec[] = []
  await plugin.onload({ files: { register: (s: FileTypeSpec) => specs.push(s) } } as unknown as PluginAPI)
  return specs[0]
}

function mount(spec: FileTypeSpec, tree: ISharedTree, user: string, legacy?: ISharedMap) {
  const ctx: FileContext = {
    vaultId: 'v1', path: 'equipe.chat', userId: user, userName: user.toUpperCase(), tree,
    shared: legacy ? { openMap: () => legacy } : undefined,
  }
  const el = document.createElement('div')
  spec.open!('equipe.chat', ctx).mount(el)
  return el
}

function send(el: HTMLElement, text: string) {
  ;(el.querySelector('[data-testid="chat-input"]') as HTMLInputElement).value = text
  el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
}

const texts = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-testid="chat-text"]')).map(n => n.textContent)

function pair(): [InMemorySharedTree, InMemorySharedTree] {
  const a = new InMemorySharedTree()
  const b = new InMemorySharedTree()
  InMemorySharedTree.link(a, b)
  return [a, b]
}

describe('plugin-chat dans le CRDT du document', () => {
  it('les messages de deux membres arrivent chez les deux, dans l\'ordre', async () => {
    const spec = await chatSpec()
    const [ta, tb] = pair()
    const alice = mount(spec, ta, 'alice')
    const bob = mount(spec, tb, 'bob')
    send(alice, 'Bonjour')
    send(bob, 'Salut Alice')
    expect(texts(alice)).toEqual(['Bonjour', 'Salut Alice'])
    expect(texts(bob)).toEqual(['Bonjour', 'Salut Alice'])
  })

  it('chaque message est une cle de la racine du document', () => {
    const [ta] = pair()
    const m = postMessage(treeMessageMap(ta), { id: 'a', name: 'A' }, 'un')!
    expect(ta.root.keys()).toEqual([`msg/${m.id}`])
    expect(readMessages(treeMessageMap(ta))).toEqual([m])
  })

  it('les anciens messages (carte du vault) restent lisibles ; les nouveaux vont dans le document', async () => {
    const spec = await chatSpec()
    const data = new Map<string, unknown>()
    const legacy: ISharedMap = {
      set: (k, v) => { data.set(k, v) },
      delete: (k) => { data.delete(k) },
      getAll: () => [...data.entries()].map(([id, value]) => ({ id, value })),
      onChange: () => () => {},
    }
    postMessage(legacy, { id: 'a', name: 'A' }, 'Ancien', new Date('2026-10-01T10:00:00Z'))
    const [ta] = pair()
    const el = mount(spec, ta, 'bob', legacy)
    send(el, 'Nouveau')
    expect(texts(el)).toEqual(['Ancien', 'Nouveau'])
    expect(data.size).toBe(1)
    expect(ta.root.keys()).toHaveLength(1)
  })
})
