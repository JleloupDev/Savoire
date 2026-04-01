// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { describe, expect, it, vi } from 'vitest'
import { PluginAPIAdapter } from '@savoire/application'
import type {
  BlockRegistry,
  CommandRegistry,
  FileTypeRegistry,
  HookRegistry,
  SlashRegistry,
  TriggerRegistry,
  VaultAPI,
  ViewRegistry,
  WorkspaceAPI,
} from '@savoire/plugin-api'

function makeVault(): VaultAPI {
  return {
    read: vi.fn(async () => 'ok'),
    readDocumentByPath: vi.fn(async () => 'ok'),
    write: vi.fn(async () => {}),
    list: vi.fn(async () => ['a.md']),
    exists: vi.fn(async () => true),
    resolveDocumentId: vi.fn(() => 'doc-1'),
    createFile: vi.fn(async () => {}),
    createFolder: vi.fn(async () => {}),
    renameFile: vi.fn(async () => {}),
    deleteFile: vi.fn(async () => {}),
    deleteFolder: vi.fn(async () => {}),
  }
}

function makeWorkspace(): WorkspaceAPI {
  return {
    openFile: vi.fn(async () => {}),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    getActiveDocument: vi.fn(() => undefined),
    subscribeVaultChange: vi.fn(() => () => {}),
    notifyVaultChange: vi.fn(),
  }
}

function makeCommands(): CommandRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
  }
}

function makeViews(): ViewRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    getAll: vi.fn(() => []),
  }
}

function makeBlocks(): BlockRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    detectBlock: vi.fn(() => null),
    getAll: vi.fn(() => []),
  }
}

function makeHooks(): HookRegistry {
  return {
    beforeParse: vi.fn(),
    afterParse: vi.fn(),
    beforeRender: vi.fn(),
    afterRender: vi.fn(),
    onDocumentOpen: vi.fn(),
    onDocumentSave: vi.fn(),
    onSelectionChange: vi.fn(),
    runBeforeParse: vi.fn(async (s: string) => s),
    runBeforeParseSync: vi.fn((s: string) => s),
    runAfterRender: vi.fn(async (s: string) => s),
    runDocumentOpen: vi.fn(),
    runDocumentSave: vi.fn(),
  }
}

function makeFiles(): FileTypeRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
  }
}

function makeSlash(): SlashRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    getAll: vi.fn(() => []),
  }
}

function makeTriggers(): TriggerRegistry {
  return {
    register: vi.fn(),
    unregister: vi.fn(),
    getAll: vi.fn(() => []),
    findConflict: vi.fn(() => undefined),
  }
}

describe('PluginAPIAdapter', () => {
  it('delegates vault/workspace/registries to inner implementations', async () => {
    const vault = makeVault()
    const workspace = makeWorkspace()
    const commands = makeCommands()
    const views = makeViews()
    const blocks = makeBlocks()
    const hooks    = makeHooks()
    const files    = makeFiles()
    const slash    = makeSlash()
    const triggers = makeTriggers()

    const api = new PluginAPIAdapter({
      vault, workspace, commands, views, blocks, hooks, files, slash, triggers,
    })

    await api.vault.read('doc-1')
    expect(vault.read).toHaveBeenCalledWith('doc-1')

    await api.workspace.openFile('x.md')
    expect(workspace.openFile).toHaveBeenCalledWith('x.md')

    api.commands.register({ id: 'cmd-1', run: () => {} })
    expect(commands.register).toHaveBeenCalled()

    api.views.register({
      id: 'v',
      title: 'V',
      container: 'left',
      createView: () => ({ render: () => null }),
    })
    expect(views.register).toHaveBeenCalled()

    api.blocks.getAll()
    expect(blocks.getAll).toHaveBeenCalled()

    api.hooks.runDocumentOpen('x.md')
    expect(hooks.runDocumentOpen).toHaveBeenCalledWith('x.md')

    api.files.unregister('.bin')
    expect(files.unregister).toHaveBeenCalledWith('.bin')
  })
})

