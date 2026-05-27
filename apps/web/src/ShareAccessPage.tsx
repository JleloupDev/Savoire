// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ShareAccessPage — public page accessible via a share link.
// Exchanges the share token for a SharedDocumentHandle (CRDT + metadata),
// then renders the document as read-only or editable according to the permission.

import { useState, useEffect, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { DocumentView } from '@savoire/editor-core'
import { PluginAPIImpl, PluginLoader } from '@savoire/plugin-runtime'
import type { VaultAPI, VaultPlugin } from '@savoire/plugin-api'
import type { ISharingAPI, SharedDocumentHandle } from '@savoire/application'
import { pluginRegistry } from './pluginRegistry'
import excalidrawPlugin from '@savoire/plugin-excalidraw'
import mindmapPlugin from '@savoire/plugin-mindmap'
import calloutPlugin from '@savoire/plugin-callout'
import codeBlockPlugin from '@savoire/plugin-code-block'
import taskListPlugin from '@savoire/plugin-task-list'
import noteEmbedPlugin from '@savoire/plugin-note-embed'
import { createWikilinksPlugin } from '@savoire/plugin-wikilinks'
import modulePlugin from '@savoire/plugin-module'
import mermaidPlugin from '@savoire/plugin-mermaid'
import tablePlugin from '@savoire/plugin-table'

const SHARE_FILE_TYPE_PLUGINS: VaultPlugin[] = [excalidrawPlugin, mindmapPlugin]

const SHARE_DEFAULT_PLUGINS: VaultPlugin[] = [
  mermaidPlugin, calloutPlugin, codeBlockPlugin, createWikilinksPlugin(),
  noteEmbedPlugin, modulePlugin, taskListPlugin, tablePlugin,
]

function createShareVault(handle: SharedDocumentHandle): VaultAPI {
  return {
    read:                () => Promise.resolve(''),
    readDocumentByPath:  () => Promise.resolve(''),
    write:               () => Promise.resolve(),
    list:                () => Promise.resolve([handle.path]),
    exists:              (id) => Promise.resolve(id === handle.docId),
    resolveDocumentId:   (path) => path === handle.path ? handle.docId : undefined,
    getVaultId:          () => handle.vaultId,
    getToken:            () => handle.accessToken,
  }
}

// ── ShareDocumentEditor ───────────────────────────────────────────────────────

function ShareDocumentEditor({ handle }: { handle: SharedDocumentHandle }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const ro = handle.permission === 'read'

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let cancelled = false
    let view: DocumentView | null = null
    let loader: PluginLoader | null = null

    const vault = createShareVault(handle)

    const start = async () => {
      const pluginApi = PluginAPIImpl.create(vault, handle.sync)
      loader = new PluginLoader()
      for (const p of SHARE_FILE_TYPE_PLUGINS) await loader.loadInternal(p, pluginApi)
      for (const p of SHARE_DEFAULT_PLUGINS) await loader.loadInternal(p, pluginApi)
      if (cancelled) { await loader.unloadAll(); return }
      view = new DocumentView({
        path: handle.path,
        container,
        vault,
        fileTypeRegistry: pluginApi.files,
        vaultId: handle.vaultId,
        docId: handle.docId,
        userId: 'share',
        readOnly: ro,
        crdt: handle.crdt,
        getTransportState: () => handle.transport.getState(),
        pluginAPI: pluginApi,
        defaultPlugins: SHARE_DEFAULT_PLUGINS,
        pluginRegistry,
      })
      view.mount()
      void handle.transport.join(handle.vaultId, handle.docId)
    }

    void start().catch(console.error)
    return () => {
      cancelled = true
      view?.destroy()
      if (loader) void loader.unloadAll()
    }
  }, [handle, ro])

  return (
    <div
      ref={containerRef}
      style={{ height: '100%' }}
      data-testid={`editor-${handle.docId}`}
      data-doc-id={handle.docId}
      data-path={handle.path}
      data-readonly={String(ro)}
      data-user-id="share"
      data-has-crdt="true"
    />
  )
}

// ── Page shell ────────────────────────────────────────────────────────────────

export function ShareAccessPage({ sharingApi }: { sharingApi: ISharingAPI }) {
  const { token } = useParams<{ token: string }>()
  const [handle, setHandle] = useState<SharedDocumentHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    let disposed = false
    let activeHandle: SharedDocumentHandle | null = null

    sharingApi.openSharedDocument(token)
      .then(h => {
        if (disposed) { h.dispose(); return }
        activeHandle = h
        setHandle(h)
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))

    return () => {
      disposed = true
      activeHandle?.dispose()
    }
  }, [token, sharingApi])

  if (loading) return <FullPage><Status>Vérification du lien…</Status></FullPage>
  if (error)   return <FullPage><Status error>Lien invalide ou expiré. ({error})</Status></FullPage>
  if (!handle) return null

  const ro = handle.permission === 'read'

  return (
    <FullPage>
      <div style={{ height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text)' }}>
            {handle.filename}
          </span>
          {handle.permission && (
            <PermBadge readOnly={ro} />
          )}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <ShareDocumentEditor handle={handle} />
      </div>
    </FullPage>
  )
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', color: 'var(--text)', fontFamily: 'var(--font-ui)' }}>
      {children}
    </div>
  )
}

function Status({ children, error }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: error ? 'var(--color-danger)' : 'var(--text-faint)', fontSize: '0.88rem' }}>
      {children}
    </div>
  )
}

function PermBadge({ readOnly: ro }: { readOnly: boolean }) {
  const bg = ro ? 'rgba(37,99,235,0.12)' : 'rgba(21,128,61,0.15)'
  const color = ro ? 'var(--color-info)' : 'var(--color-success)'
  return (
    <span style={{ fontSize: '0.68rem', padding: '2px 8px', borderRadius: 10, background: bg, color, fontWeight: 600 }}>
      {ro ? 'Lecture seule' : 'Édition'}
    </span>
  )
}
