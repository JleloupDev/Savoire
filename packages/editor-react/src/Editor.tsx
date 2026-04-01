// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useEffect, useRef, useState, useId } from 'react'
import { EditorCore } from '@savoire/editor-core'
import type { EditorController } from '@savoire/editor-core'
import type { VaultAPI, VaultPlugin } from '@savoire/plugin-api'
import { EditorContext } from './EditorContext'
import { Toolbar } from './Toolbar'
import { BubbleToolbar } from './BubbleToolbar'
import { TriggerOverlay } from './TriggerOverlay'

export interface EditorProps {
  serverUrl?: string
  vaultId?: string
  docId?: string
  userId?: string
  initialContent?: string
  /** Vault implementation forwarded to plugins (read/write embedded files). */
  vault?: VaultAPI
  style?: React.CSSProperties
  /** When true, the editor is read-only (no editing, no keymaps). */
  readOnly?: boolean
  /** Show the Markdown toolbar above the editor. */
  showToolbar?: boolean
  /** Show the floating bubble toolbar when text is selected. */
  showBubbleToolbar?: boolean
  /** Show the Notion-style slash command palette when typing / at line start. */
  showSlashMenu?: boolean
  /** Show the generic trigger overlay (replaces showSlashMenu — both are honored). */
  showTriggerOverlay?: boolean
  /** Called once the EditorController is ready (or null when destroyed). */
  onReady?: (controller: EditorController | null) => void
  /** Path of the open file — used to auto-load plugin by extension. */
  filePath?: string
  /** External plugin registry forwarded to EditorCore for note-scoped loading. */
  pluginRegistry?: Record<string, () => Promise<import('@savoire/plugin-api').VaultPlugin>>
  /** Plugins active for every note by default. Forwarded to EditorCore. */
  defaultPlugins?: VaultPlugin[]
  /** Shared PluginAPIImpl from the app layer. When provided, EditorCore reuses it
   *  instead of creating its own — plugins are loaded once for all tabs. */
  pluginAPI?: import('@savoire/plugin-runtime').PluginAPIImpl
  /** JWT token factory for authenticated SignalR hubs. */
  getToken?: () => string | null
}

// see ADR-023
export function Editor({
  serverUrl, vaultId, docId, userId, initialContent, vault, style,
  readOnly, showToolbar, showBubbleToolbar, showSlashMenu, showTriggerOverlay, onReady,
  filePath, pluginRegistry, defaultPlugins, pluginAPI, getToken,
}: EditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const coreRef = useRef<EditorController | null>(null)
  const [controller, setController] = useState<EditorController | null>(null)
  const clientId = useId()

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const core = new EditorCore({
      container,
      serverUrl,
      vaultId,
      docId,
      userId,
      clientId,
      initialContent,
      vault,
      readOnly,
      filePath,
      pluginRegistry,
      defaultPlugins,
      pluginAPI,
      getToken,
    })

    coreRef.current = core
    setController(core)
    onReady?.(core)

    return () => {
      core.destroy()
      coreRef.current = null
      setController(null)
      onReady?.(null)
    }
  }, [serverUrl, vaultId, docId, userId, clientId, initialContent, vault, readOnly, filePath, pluginRegistry, defaultPlugins, pluginAPI])

  return (
    <EditorContext.Provider value={controller}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', ...style }}>
        {showToolbar && !readOnly && <Toolbar />}
        <div
          ref={containerRef}
          style={{ flex: 1, overflow: 'auto', minHeight: 0 }}
        />
      </div>
      {showBubbleToolbar && !readOnly && <BubbleToolbar />}
      {(showSlashMenu || showTriggerOverlay) && !readOnly && <TriggerOverlay />}
    </EditorContext.Provider>
  )
}
