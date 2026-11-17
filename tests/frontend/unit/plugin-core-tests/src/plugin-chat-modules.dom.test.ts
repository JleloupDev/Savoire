// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Modules dans une discussion (comme Teams) : une ligne `@[[Note]]` ou
// `![[Note]]` d'un message est rendue par le plugin qui la reconnait ; un
// nouveau message ne redessine pas les modules deja affiches.
import { describe, it, expect, vi } from 'vitest'
import plugin, { postMessage } from '@savoire/plugin-chat'
import { BLOCK_DESTROY_EVENT } from '@savoire/plugin-api'
import type { BlockSpec, FileContext, FileTypeSpec, ISharedMap, PluginAPI } from '@savoire/plugin-api'

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

function setup() {
  const rendered: string[] = []
  const destroyed: string[] = []
  const moduleSpec = {
    detect: /@\[\[(.+?)\]\]/,
    deserialize: (raw: string) => ({ path: /@\[\[(.+?)\]\]/.exec(raw)![1] }),
    renderClient: (data: { path: string }) => {
      rendered.push(data.path)
      const el = document.createElement('div')
      el.dataset.module = data.path
      el.textContent = `module ${data.path}`
      el.addEventListener(BLOCK_DESTROY_EVENT, () => destroyed.push(data.path))
      return el
    },
  } as unknown as BlockSpec
  const api = {
    files: { register: (s: FileTypeSpec) => specs.push(s) },
    blocks: { detectBlock: (text: string) => (moduleSpec.detect as RegExp).test(text) ? { type: 'module', spec: moduleSpec } : null },
    vault: { list: vi.fn(async () => ['Projets/Plan.md', 'Tableau.board', 'equipe.chat']) },
  } as unknown as PluginAPI
  const specs: FileTypeSpec[] = []
  return { api, specs, rendered, destroyed }
}

async function open(user = 'alice') {
  const s = setup()
  await plugin.onload(s.api)
  const map = memoryMap()
  const ctx: FileContext = { vaultId: 'v1', path: 'equipe.chat', userId: user, userName: user, shared: { openMap: () => map } }
  const el = document.createElement('div')
  document.body.appendChild(el)
  s.specs[0].open!('equipe.chat', ctx).mount(el)
  const send = (text: string) => {
    ;(el.querySelector('[data-testid="chat-input"]') as HTMLInputElement).value = text
    el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }))
  }
  return { ...s, el, map, send }
}

describe('plugin-chat : modules dans les messages', () => {
  it('une ligne @[[...]] devient le module ; le texte autour reste du texte', async () => {
    const { el, send, rendered, map } = await open()
    send('Voici le plan :')
    // Un message a plusieurs lignes (texte saisi, puis module choisi) : texte, puis module.
    postMessage(map, { id: 'alice', name: 'alice' }, 'A relire\n@[[Projets/Plan.md]]')
    expect(rendered).toEqual(['Projets/Plan.md'])
    const embed = el.querySelector('[data-testid="chat-embed"]')!
    expect(embed.querySelector('[data-module="Projets/Plan.md"]')).not.toBeNull()
    expect(Array.from(el.querySelectorAll('[data-testid="chat-text"]')).map(n => n.textContent)).toEqual(['Voici le plan :', 'A relire'])
  })

  it('un nouveau message ne redessine pas les modules deja affiches', async () => {
    const { el, send, rendered, destroyed } = await open()
    send('@[[Projets/Plan.md]]')
    const first = el.querySelector('[data-module="Projets/Plan.md"]')
    send('Un autre message')
    send('Encore un')
    expect(rendered).toEqual(['Projets/Plan.md'])
    expect(el.querySelector('[data-module="Projets/Plan.md"]')).toBe(first)
    expect(destroyed).toEqual([])
  })

  it('un message retire libere son module', async () => {
    const { send, map, destroyed } = await open()
    send('@[[Tableau.board]]')
    const [entry] = map.getAll()
    map.delete(entry.id)
    expect(destroyed).toEqual(['Tableau.board'])
  })

  it('le bouton Module choisit un fichier du vault et l envoie comme module', async () => {
    const { el, rendered } = await open()
    ;(el.querySelector('[data-testid="chat-module"]') as HTMLButtonElement).click()
    await new Promise(r => setTimeout(r, 0))
    const choices = Array.from(el.querySelectorAll<HTMLButtonElement>('[data-testid="chat-module-choice"]')).map(b => b.dataset.path)
    expect(choices).toEqual(['Projets/Plan.md', 'Tableau.board'])
    el.querySelector<HTMLButtonElement>('[data-path="Tableau.board"]')!.click()
    expect(rendered).toEqual(['Tableau.board'])
    expect(el.querySelector('[data-testid="chat-module-picker"]')).toBeNull()
  })
})
