// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useCallback, useMemo } from 'react'
import { WorkspaceRoot } from '@savoire/workspace'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import filetreePlugin from '@savoire/plugin-filetree'
import type { VaultAPI, PluginAPI, ViewRegistry, CommandRegistry, HookRegistry, BlockRegistry, FileTypeRegistry } from '@savoire/plugin-api'
import { MemoryVaultProvider } from './mock/MemoryVaultProvider'
import { ALL_MOCK_SETS } from './mock/mockFileSets'

// ─── Mock VaultAPI wrapping MemoryVaultProvider ────────────────────────────

function makeVaultAPI(files: Record<string, string>): VaultAPI {
  const provider = new MemoryVaultProvider(files)
  return {
    read: (documentId) => provider.read(documentId),
    readDocumentByPath: (path) => provider.readDocumentByPath(path),
    write: (documentId, content) => provider.write(documentId, content),
    list: async (dir?) => {
      const all = await provider.list()
      return dir ? all.filter((f) => f.startsWith(dir)) : all
    },
    exists: (documentId) => provider.exists(documentId),
    resolveDocumentId: (path) =>
      Object.prototype.hasOwnProperty.call(files, path)
        ? path
        : Object.prototype.hasOwnProperty.call(files, `${path}.md`)
          ? `${path}.md`
          : undefined,
  }
}

// ─── Minimal PluginAPI stub used to load the filetree plugin ──────────────

function makePluginAPI(views: ViewRegistry, vault: VaultAPI): PluginAPI {
  const noop = () => {}
  const commands: CommandRegistry = { register: noop, unregister: noop }
  const hooks: HookRegistry = {
    beforeParse: noop,
    afterParse: noop,
    beforeRender: noop,
    afterRender: noop,
    onDocumentOpen: noop,
    onDocumentSave: noop,
    onSelectionChange: noop,
    runBeforeParse: async (s) => s,
    runBeforeParseSync: (s) => s,
    runAfterRender: async (h) => h,
    runDocumentOpen: noop,
    runDocumentSave: noop,
  }
  const blocks: BlockRegistry = {
    register: noop,
    unregister: noop,
    detectBlock: () => null,
    getAll: () => [],
  }
  const files: FileTypeRegistry = { register: noop, unregister: noop }
  const workspace = { openFile: async () => {}, openPanel: noop, closePanel: noop, getActiveDocument: () => undefined }
  const slash = { register: noop, unregister: noop, getAll: () => [] }
  const triggers = { register: noop, unregister: noop, getAll: () => [], findConflict: () => undefined }
  const editor = { getCursorCoords: () => null, getSelectionCoords: () => null, getSelectionText: () => '' }
  const toolbar = { register: noop, unregister: noop, getAll: () => [], getByGroup: () => [] }
  return { commands, hooks, blocks, files, vault, views, workspace, slash, triggers, editor, toolbar }
}

// ─── WorkspacePlayground ──────────────────────────────────────────────────

export function WorkspacePlayground({ onBack }: { onBack: () => void }) {
  const vault = useMemo(() => makeVaultAPI(ALL_MOCK_SETS[2].files), [])

  const onBeforeReady = useCallback(
    async (manager: WorkspaceManagerImpl) => {
      const api = makePluginAPI(manager.views, vault)
      await filetreePlugin.onload(api)
    },
    [vault],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <header
        style={{
          padding: '6px 12px',
          background: '#1e1e2e',
          borderBottom: '1px solid #313244',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <strong style={{ color: '#cdd6f4', fontSize: 13 }}>Workspace Playground</strong>
        <span style={{ color: '#585b70', fontSize: 12 }}>— Dockview + FileTree plugin demo</span>
        <button
          onClick={onBack}
          style={{
            marginLeft: 'auto',
            fontSize: 11,
            padding: '2px 8px',
            background: '#313244',
            color: '#cdd6f4',
            border: '1px solid #45475a',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          ← Back to Editor
        </button>
      </header>

      <WorkspaceRoot
        vault={vault}
        onBeforeReady={onBeforeReady}
        style={{ flex: 1, overflow: 'hidden' }}
      />
    </div>
  )
}
