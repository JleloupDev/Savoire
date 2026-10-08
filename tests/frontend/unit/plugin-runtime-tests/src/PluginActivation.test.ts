// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Desactiver un plugin = filtrer ce qu'il a enregistre, sans le decharger.
// Reactiver le retrouve tel quel. Ce que l'application enregistre elle-meme
// (aucun plugin en cours) reste toujours actif.
import { describe, it, expect, vi } from 'vitest'
import { PluginActivation, PluginAPIImpl, PluginLoader } from '@savoire/plugin-runtime'
import type { VaultPlugin } from '@savoire/plugin-api'

function tablePlugin(): VaultPlugin {
  return {
    manifest: { id: 'plugin-table', name: 'Tables', version: '1.0.0', scope: 'vault' },
    async onload(api) {
      api.files.register({ extension: 'table', label: 'Tableau', icon: '📊', create: async () => '', open: () => ({ mount() {}, destroy() {} }) })
      api.commands.register({ id: 'table.insert', label: 'Insérer', run: () => {} })
      api.slash.register({ id: 'table', label: 'Table', insert: () => '' } as never)
      api.toolbar.register({ id: 'table-btn', group: 'insert', label: 'T', run: () => {} } as never)
      api.triggers.register({ id: 'table-trigger', character: '|', description: 'tables' })
      api.hooks.onDocumentOpen(onOpen)
    },
    async onunload() {},
  }
}
const onOpen = vi.fn()

async function setup() {
  const api = PluginAPIImpl.create()
  const activation = new PluginActivation()
  api.attachActivation(activation)
  // Enregistre par l'application elle-meme : n'appartient a aucun plugin.
  api.files.register({ extension: 'md', label: 'Note', icon: '📝', create: async () => '' })
  await new PluginLoader().loadInternal(tablePlugin(), api)
  return { api, activation }
}

describe('PluginActivation', () => {
  it('un plugin actif expose tout ce qu\'il a enregistre', async () => {
    const { api } = await setup()
    expect(api.files.resolve('table')).toBeDefined()
    expect(api.commands.getAll().map(c => c.id)).toEqual(['table.insert'])
    expect(api.slash.getAll().map(i => i.id)).toEqual(['table'])
    expect(api.toolbar.getAll().map(c => c.id)).toEqual(['table-btn'])
    expect(api.triggers.getAll().map(t => t.id)).toEqual(['table-trigger'])
  })

  it('desactive : tout est filtre, rien n\'est perdu', async () => {
    const { api, activation } = await setup()
    activation.setDisabled(['plugin-table'])
    expect(api.files.resolve('table')).toBeUndefined()
    expect(api.files.getAll().map(s => s.extension)).toEqual(['md'])
    expect(api.commands.getAll()).toEqual([])
    expect(api.slash.getAll()).toEqual([])
    expect(api.toolbar.getAll()).toEqual([])
    expect(api.triggers.getAll()).toEqual([])
    onOpen.mockClear()
    api.hooks.runDocumentOpen('a.md')
    expect(onOpen).not.toHaveBeenCalled()

    activation.setDisabled([])
    expect(api.files.resolve('table')).toBeDefined()
    api.hooks.runDocumentOpen('a.md')
    expect(onOpen).toHaveBeenCalledWith('a.md')
  })

  it('le proprietaire d\'un type reste connu quand son plugin est desactive', async () => {
    const { api, activation } = await setup()
    activation.setDisabled(['plugin-table'])
    expect(api.files.ownerOf('table')).toBe('plugin-table')
    expect(api.files.ownerOf('md')).toBeUndefined()
  })

  it('une commande d\'un plugin desactive ne s\'execute pas', async () => {
    const run = vi.fn()
    const api = PluginAPIImpl.create()
    const activation = new PluginActivation()
    api.attachActivation(activation)
    await new PluginLoader().loadInternal({
      manifest: { id: 'p', name: 'P', version: '1' },
      async onload(a) { a.commands.register({ id: 'c', label: 'C', run }) },
      async onunload() {},
    }, api)
    activation.setDisabled(['p'])
    api.commands.execute('c', { editorView: null })
    expect(run).not.toHaveBeenCalled()
  })

  it('les agents d\'un plugin desactive disparaissent', async () => {
    const api = PluginAPIImpl.create()
    const activation = new PluginActivation()
    api.attachActivation(activation)
    await new PluginLoader().loadInternal({
      manifest: { id: 'p-agent', name: 'P', version: '1', permissions: ['agents'] },
      async onload(a) { a.agents?.register({ id: 'ag', name: 'Ag', description: '', requires: [], run: async () => {} }) },
      async onunload() {},
    }, api)
    expect(api.agents.getAll().map(a => a.id)).toEqual(['ag'])
    activation.setDisabled(['p-agent'])
    expect(api.agents.getAll()).toEqual([])
  })

  it('notifie seulement quand l\'ensemble change', () => {
    const activation = new PluginActivation()
    const cb = vi.fn()
    activation.onChange(cb)
    activation.setDisabled(['a'])
    activation.setDisabled(['a'])
    activation.setDisabled([])
    expect(cb).toHaveBeenCalledTimes(2)
  })

  it('l\'id du plugin courant est remis a zero meme si onload echoue', async () => {
    const api = PluginAPIImpl.create()
    const activation = new PluginActivation()
    api.attachActivation(activation)
    await expect(new PluginLoader().loadInternal({
      manifest: { id: 'casse', name: 'Casse', version: '1' },
      async onload() { throw new Error('boom') },
      async onunload() {},
    }, api)).rejects.toThrow('boom')
    expect(activation.currentPluginId).toBeUndefined()
  })
})
