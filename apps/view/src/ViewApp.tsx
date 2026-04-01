// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useEffect, useRef, useState } from 'react'
import { DocumentView } from '@savoire/editor-core'
import { DocumentRoomClient, RestDocumentFetcher } from '@savoire/infrastructure-sync'
import { PluginAPIImpl, PluginLoader } from '@savoire/plugin-runtime'
import type { VaultAPI, VaultPlugin } from '@savoire/plugin-api'
import excalidrawPlugin from '@savoire/plugin-excalidraw'
import mindmapPlugin from '@savoire/plugin-mindmap'
import mermaidPlugin from '@savoire/plugin-mermaid'
import calloutPlugin from '@savoire/plugin-callout'
import codeBlockPlugin from '@savoire/plugin-code-block'
import taskListPlugin from '@savoire/plugin-task-list'
import noteEmbedPlugin from '@savoire/plugin-note-embed'
import wikilinksPlugin from '@savoire/plugin-wikilinks'
import modulePlugin from '@savoire/plugin-module'
import tablePlugin from '@savoire/plugin-table'
import plaintextPlugin from '@savoire/plugin-plaintext'
import { pluginRegistry } from './pluginRegistry'

export interface ViewAppParams {
  grantToken?: string
  vaultId?: string
  docId?: string
  path?: string
  token?: string
  userId?: string
  readOnly: boolean
  serverUrl?: string
}

class DirectVaultAPI implements VaultAPI {
  private readonly fetcher: RestDocumentFetcher

  constructor(
    private readonly vaultId: string,
    private readonly token: string,
    private readonly docId: string,
    private readonly path: string,
    baseUrl?: string,
  ) {
    this.fetcher = new RestDocumentFetcher({ baseUrl: baseUrl ?? '' })
  }

  async read(documentId: string): Promise<string> {
    return this.fetcher.getDocumentContent(this.vaultId, documentId, this.token)
  }

  async readDocumentByPath(path: string): Promise<string> {
    const resolved = this.resolveDocumentId(path)
    if (!resolved) throw new Error(`Document not found for path: ${path}`)
    return this.read(resolved)
  }

  async write(documentId: string, content: string): Promise<void> {
    return this.fetcher.writeDocumentContent(this.vaultId, documentId, content, this.token)
  }

  async list(dir?: string): Promise<string[]> {
    const prefix = dir ? (dir.endsWith('/') ? dir : `${dir}/`) : ''
    return this.path.startsWith(prefix) ? [this.path] : []
  }

  async exists(documentId: string): Promise<boolean> {
    try {
      await this.read(documentId)
      return true
    } catch {
      return false
    }
  }

  resolveDocumentId(path: string): string | undefined {
    if (path === this.path) return this.docId
    if (!path.includes('.') && `${path}.md` === this.path) return this.docId
    return undefined
  }

  getVaultId(): string {
    return this.vaultId
  }

  getToken(): string {
    return this.token
  }
}

const defaultPlugins: VaultPlugin[] = [
  mermaidPlugin,
  calloutPlugin,
  codeBlockPlugin,
  wikilinksPlugin,
  noteEmbedPlugin,
  modulePlugin,
  taskListPlugin,
  tablePlugin,
]

const fileTypePlugins: VaultPlugin[] = [
  excalidrawPlugin,
  mindmapPlugin,
  plaintextPlugin,
]

interface ViewAccessDto {
  accessToken: string
  vaultId: string
  docId: string
  path: string
  permission: string
  expiresAt: string
  userId?: string
}

async function redeemGrant(grantToken: string): Promise<ViewAccessDto> {
  const res = await fetch('/api/v1/view/grants/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantToken }),
  })
  if (!res.ok) throw new Error(`redeem failed (${res.status})`)
  return res.json() as Promise<ViewAccessDto>
}

export function ViewApp({ params }: { params: ViewAppParams }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let cancelled = false
    let view: DocumentView | null = null
    let loader: PluginLoader | null = null

    const start = async () => {
      setError(null)
      const access = params.grantToken
        ? await redeemGrant(params.grantToken)
        : {
            accessToken: params.token ?? '',
            vaultId: params.vaultId ?? '',
            docId: params.docId ?? '',
            path: params.path ?? '',
            permission: params.readOnly ? 'read' : 'write',
            expiresAt: '',
            userId: params.userId,
          }
      if (!access.accessToken || !access.vaultId || !access.docId || !access.path) {
        throw new Error('Missing view bootstrap params')
      }
      const vault = new DirectVaultAPI(
        access.vaultId,
        access.accessToken,
        access.docId,
        access.path,
        params.serverUrl,
      )
      const sync = new DocumentRoomClient({
        serverUrl: params.serverUrl ?? '',
        getToken: () => access.accessToken,
      })
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
        readOnly: params.readOnly || access.permission !== 'write',
        pluginAPI: pluginApi,
        defaultPlugins,
        pluginRegistry,
        serverUrl: params.serverUrl ?? '',
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
  }, [params.docId, params.grantToken, params.path, params.readOnly, params.serverUrl, params.token, params.userId, params.vaultId])

  if (error) {
    return (
      <div className="view-status view-status-error">
        {error}
      </div>
    )
  }

  return <div ref={containerRef} className="view-root" />
}
