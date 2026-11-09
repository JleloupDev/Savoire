// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useEffect, useRef, useState } from 'react'
import { DocumentView } from '@savoire/editor-core'
import { PluginAPIImpl, PluginLoader } from '@savoire/plugin-runtime'
import { YjsCrdtAdapter, SignalRTransport, DocumentRoomClient, LocalKeyProvider, serverUrl } from '@savoire/infrastructure-sync'
import { CollabOrchestrator } from '@savoire/application'
import type { VaultAPI, VaultPlugin } from '@savoire/plugin-api'
import { createWikilinksPlugin } from '@savoire/plugin-wikilinks'
import { pluginRegistry } from './pluginRegistry'
import { loadModulePlugins } from './pluginStore'

interface ViewAccessDto {
  accessToken: string
  vaultId: string
  docId: string
  path: string
  permission: string
  expiresAt: string
  userId?: string
}

// Les plugins du module : ceux du document (blocs des notes, type du
// fichier), pas l'environnement de travail. Voir modulePluginEntries.

async function redeemGrant(grantToken: string): Promise<ViewAccessDto> {
  const res = await fetch(serverUrl('/api/v1/view/grants/redeem'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grantToken }),
  })
  if (!res.ok) throw new Error(`redeem failed (${res.status})`)
  return res.json() as Promise<ViewAccessDto>
}

// VaultAPI minimale — le contenu est livré via le CRDT, pas via read()/write().
function createViewVault(access: ViewAccessDto): VaultAPI {
  return {
    read:               (id) => Promise.reject(new Error(`read(${id}) not supported: content is delivered via CRDT`)),
    readDocumentByPath: (p)  => Promise.reject(new Error(`readDocumentByPath(${p}) not supported on a view grant`)),
    write:              () => Promise.resolve(),
    list:               () => Promise.resolve([access.path]),
    exists:             (id) => Promise.resolve(id === access.docId),
    resolveDocumentId:  (p)  => p === access.path ? access.docId : undefined,
    getVaultId:         () => access.vaultId,
    getToken:           () => access.accessToken,
  }
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
    let orchestrator: CollabOrchestrator | null = null
    let crdt: YjsCrdtAdapter | null = null
    let transport: SignalRTransport | null = null

    const start = async () => {
      setError(null)

      const access = await redeemGrant(grantToken)
      if (!access.accessToken || !access.vaultId || !access.docId || !access.path) {
        throw new Error('Réponse de grant incomplète')
      }

      const ro = readOnlyParam || access.permission !== 'write'

      // Build the CRDT pipeline (same path as ShareAccessPage).
      crdt = new YjsCrdtAdapter()
      transport = new SignalRTransport({
        serverUrl: '',
        userId: access.userId ?? 'view',
        getToken: () => access.accessToken,
      })
      const sync = new DocumentRoomClient({ serverUrl: '', getToken: () => access.accessToken })
      const identity = new LocalKeyProvider()
      await identity.init()
      orchestrator = new CollabOrchestrator(crdt, transport, identity)

      const vault = createViewVault(access)
      const pluginApi = PluginAPIImpl.create(vault, sync)
      loader = new PluginLoader()
      const plugins = await loadModulePlugins(access.path)
      const defaultPlugins: VaultPlugin[] = [createWikilinksPlugin(), ...plugins.editor]
      for (const plugin of plugins.fileTypes) await loader.loadInternal(plugin, pluginApi)
      for (const plugin of defaultPlugins) await loader.loadInternal(plugin, pluginApi)

      if (cancelled) { await loader.unloadAll(); return }

      view = new DocumentView({
        path: access.path,
        container,
        vault,
        fileTypeRegistry: pluginApi.files,
        vaultId: access.vaultId,
        docId: access.docId,
        userId: access.userId ?? 'view',
        readOnly: ro,
        crdt,
        getTransportState: () => transport!.getState(),
        pluginAPI: pluginApi,
        defaultPlugins,
        pluginRegistry,
      })
      view.mount()
      void transport.join(access.vaultId, access.docId)
    }

    void start().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Impossible d'ouvrir le document: ${msg}`)
    })

    return () => {
      cancelled = true
      view?.destroy()
      orchestrator?.dispose()
      crdt?.dispose()
      void transport?.disconnect()
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
