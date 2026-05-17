// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useEffect, useRef, useState } from 'react'
import { DocumentView } from '@savoire/editor-core'
import { DirectVaultAPI, createDocumentRoomClient } from './createWebAppRoot'
import { PluginAPIImpl, PluginLoader } from '@savoire/plugin-runtime'
import type { VaultPlugin } from '@savoire/plugin-api'
import excalidrawPlugin from '@savoire/plugin-excalidraw'
import mindmapPlugin from '@savoire/plugin-mindmap'
import mermaidPlugin from '@savoire/plugin-mermaid'
import calloutPlugin from '@savoire/plugin-callout'
import codeBlockPlugin from '@savoire/plugin-code-block'
import taskListPlugin from '@savoire/plugin-task-list'
import noteEmbedPlugin from '@savoire/plugin-note-embed'
import { createWikilinksPlugin } from '@savoire/plugin-wikilinks'
import modulePlugin from '@savoire/plugin-module'
import tablePlugin from '@savoire/plugin-table'
import { pluginRegistry } from './pluginRegistry'

interface ViewAccessDto {
  accessToken: string
  vaultId: string
  docId: string
  path: string
  permission: string
  expiresAt: string
  userId?: string
}

const defaultPlugins: VaultPlugin[] = [
  mermaidPlugin,
  calloutPlugin,
  codeBlockPlugin,
  createWikilinksPlugin(),
  noteEmbedPlugin,
  modulePlugin,
  taskListPlugin,
  tablePlugin,
]

const fileTypePlugins: VaultPlugin[] = [
  excalidrawPlugin,
  mindmapPlugin,
]

async function redeemGrant(grantToken: string): Promise<ViewAccessDto> {
  const res = await fetch('/api/v1/view/grants/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantToken }),
  })
  if (!res.ok) throw new Error(`redeem failed (${res.status})`)
  return res.json() as Promise<ViewAccessDto>
}

export function ViewGrantPage() {
  const params = new URLSearchParams(window.location.search)
  const grantToken = params.get('grant') ?? ''
  const readOnlyParam = params.get('readOnly') === 'true'

  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!grantToken) {
      setError('Paramètre manquant: grant')
      return
    }

    let cancelled = false
    let view: DocumentView | null = null
    let loader: PluginLoader | null = null

    const start = async () => {
      setError(null)

      const access = await redeemGrant(grantToken)
      if (!access.accessToken || !access.vaultId || !access.docId || !access.path) {
        throw new Error('Réponse de grant incomplète')
      }

      const vault = new DirectVaultAPI(
        access.vaultId,
        access.accessToken,
        access.docId,
        access.path,
      )
      const sync = createDocumentRoomClient({ serverUrl: '', getToken: () => access.accessToken })

      const pluginApi = PluginAPIImpl.create(vault, sync)
      loader = new PluginLoader()

      for (const plugin of fileTypePlugins) {
        await loader.loadInternal(plugin, pluginApi)
      }
      for (const plugin of defaultPlugins) {
        await loader.loadInternal(plugin, pluginApi)
      }

      if (cancelled) {
        await loader.unloadAll()
        return
      }

      view = new DocumentView({
        path: access.path,
        container,
        vault,
        sync,
        fileTypeRegistry: pluginApi.files,
        vaultId: access.vaultId,
        docId: access.docId,
        userId: access.userId ?? 'view',
        readOnly: readOnlyParam || access.permission !== 'write',
        pluginAPI: pluginApi,
        defaultPlugins,
        pluginRegistry,
        serverUrl: '',
      })
      view.mount()
    }

    void start().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Impossible d'ouvrir le document: ${msg}`)
    })

    return () => {
      cancelled = true
      view?.destroy()
      if (loader) void loader.unloadAll()
    }
  }, [grantToken, readOnlyParam])

  if (error) {
    return (
      <div style={{ height: '100%', display: 'grid', placeItems: 'center', color: '#dc2626', fontSize: 13, padding: 16 }}>
        {error}
      </div>
    )
  }

  return <div ref={containerRef} style={{ height: '100%' }} />
}
