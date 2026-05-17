// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ShareAccessPage — page publique accessible via un lien de partage.
// Échange le token de lien contre un JWT scoped, puis affiche le contenu
// en lecture seule (permission=read) ou éditable (permission=write).

import { useState, useEffect } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { Editor } from '@savoire/editor-react'
import type { VaultAPI, VaultPlugin } from '@savoire/plugin-api'
import type { ISharingAPI, AppShareLinkAccess } from '@savoire/application'
import { api } from './api'
import type { DocumentDto } from './types'
import { pluginRegistry } from './pluginRegistry'
import calloutPlugin from '@savoire/plugin-callout'
import codeBlockPlugin from '@savoire/plugin-code-block'
import taskListPlugin from '@savoire/plugin-task-list'
import noteEmbedPlugin from '@savoire/plugin-note-embed'
import { createWikilinksPlugin } from '@savoire/plugin-wikilinks'
import modulePlugin from '@savoire/plugin-module'
import mermaidPlugin from '@savoire/plugin-mermaid'
import tablePlugin from '@savoire/plugin-table'

const readOnly = (permission: string) => permission === 'read'

const SHARE_DEFAULT_PLUGINS: VaultPlugin[] = [
  mermaidPlugin, calloutPlugin, codeBlockPlugin, createWikilinksPlugin(),
  noteEmbedPlugin, modulePlugin, taskListPlugin, tablePlugin,
]

function createShareVaultApi(
  vaultId: string,
  token: string,
  listDocs: () => DocumentDto[],
): VaultAPI {
  const normalize = (path: string) => path.includes('.') ? path : `${path}.md`
  const resolveId = (path: string): string | undefined => {
    const normalized = normalize(path)
    const found = listDocs().find(d => d.path === path || d.path === normalized)
    return found?.id
  }

  return {
    async read(documentId: string): Promise<string> {
      return api.getDocumentContent(vaultId, documentId, token)
    },
    async readDocumentByPath(path: string): Promise<string> {
      const docId = resolveId(path)
      if (!docId) throw new Error(`Document introuvable: ${path}`)
      return api.getDocumentContent(vaultId, docId, token)
    },
    async write(documentId: string, content: string): Promise<void> {
      await api.putDocumentContent(vaultId, documentId, token, content)
    },
    async list(dir?: string): Promise<string[]> {
      const prefix = !dir ? '' : dir.endsWith('/') ? dir : `${dir}/`
      return listDocs().map(d => d.path).filter(p => p.startsWith(prefix))
    },
    async exists(documentId: string): Promise<boolean> {
      return listDocs().some(d => d.id === documentId)
    },
    resolveDocumentId(path: string): string | undefined {
      return resolveId(path)
    },
    getVaultId(): string {
      return vaultId
    },
    getToken(): string {
      return token
    },
  }
}

// ── Vault share — document list + editor ──────────────────────────────────────

function VaultShareView({ access }: { access: AppShareLinkAccess }) {
  const [docs, setDocs] = useState<DocumentDto[] | null>(null)
  const [selected, setSelected] = useState<DocumentDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const vaultApi = createShareVaultApi(access.resourceId, access.accessToken, () => docs ?? [])
  const getToken = () => access.accessToken

  useEffect(() => {
    api.listDocuments(access.resourceId, access.accessToken)
      .then(list => { setDocs(list); if (list.length > 0) setSelected(list[0]) })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [access.resourceId, access.accessToken])

  if (loading) return <Status>Chargement des documents…</Status>
  if (error)   return <Status error>{error}</Status>
  if (!docs)   return null

  const ro = readOnly(access.permission)

  return (
    <div style={{ display: 'flex', height: 'calc(100vh - 56px)' }}>
      {/* Sidebar */}
      <div style={{ width: 220, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto', padding: '8px 0' }}>
        {docs.length === 0
          ? <div style={{ padding: '12px 16px', color: 'var(--text-faint)', fontSize: '0.8rem' }}>Vault vide.</div>
          : docs.map(d => (
            <button
              key={d.id}
              onClick={() => setSelected(d)}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 16px', background: selected?.id === d.id ? 'var(--bg-elevated)' : 'transparent',
                border: 'none', borderLeft: selected?.id === d.id ? '2px solid var(--accent)' : '2px solid transparent',
                color: selected?.id === d.id ? 'var(--text)' : 'var(--text-muted)',
                fontSize: '0.8rem', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
            >
              {d.title ?? d.path.split('/').at(-1)}
            </button>
          ))
        }
      </div>

      {/* Editor — content loaded via CRDT (same as main editor) */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        {selected
          ? (
            <Editor
              key={selected.id}
              serverUrl=""
              vaultId={access.resourceId}
              docId={selected.id}
              userId="share"
              readOnly={ro}
              vault={vaultApi}
              getToken={getToken}
              pluginRegistry={pluginRegistry}
              defaultPlugins={SHARE_DEFAULT_PLUGINS}
              style={{ height: '100%' }}
            />
          )
          : <Status>Sélectionnez un document.</Status>
        }
      </div>
    </div>
  )
}

function VaultShareEmbedView({ access, embedPath }: { access: AppShareLinkAccess; embedPath: string }) {
  const [docs, setDocs] = useState<DocumentDto[] | null>(null)
  const [selected, setSelected] = useState<DocumentDto | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const vaultApi = createShareVaultApi(access.resourceId, access.accessToken, () => docs ?? [])
  const getToken = () => access.accessToken

  useEffect(() => {
    api.listDocuments(access.resourceId, access.accessToken)
      .then(list => {
        setDocs(list)
        const normalized = embedPath.includes('.') ? embedPath : `${embedPath}.md`
        const doc = list.find(d => d.path === embedPath || d.path === normalized)
        if (!doc) throw new Error(`Document introuvable: ${embedPath}`)
        setSelected(doc)
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [access.accessToken, access.resourceId, embedPath])

  if (loading) return <Status>Chargement du module…</Status>
  if (error) return <Status error>{error}</Status>
  if (!selected) return <Status error>Document introuvable.</Status>

  const ro = readOnly(access.permission)
  return (
    <div style={{ height: '100vh', overflow: 'hidden' }}>
      <Editor
        key={selected.id}
        serverUrl=""
        vaultId={access.resourceId}
        docId={selected.id}
        userId="share"
        readOnly={ro}
        vault={vaultApi}
        getToken={getToken}
        pluginRegistry={pluginRegistry}
        defaultPlugins={SHARE_DEFAULT_PLUGINS}
        style={{ height: '100%' }}
      />
    </div>
  )
}

// ── Document share — single editor ────────────────────────────────────────────

function DocumentShareView({ access, embedded = false }: { access: AppShareLinkAccess; embedded?: boolean }) {
  const vaultId = access.vaultId ?? ''
  const docs = [{ id: access.resourceId, path: `doc-${access.resourceId}.md`, title: null, hash: '', sizeBytes: 0, createdAt: '', updatedAt: '' }] satisfies DocumentDto[]
  const vaultApi = createShareVaultApi(vaultId, access.accessToken, () => docs)
  const getToken = () => access.accessToken
  const ro = readOnly(access.permission)

  return (
    <div style={{ height: embedded ? '100vh' : 'calc(100vh - 56px)' }}>
      <Editor
        key={access.resourceId}
        serverUrl=""
        vaultId={vaultId}
        docId={access.resourceId}
        userId="share"
        readOnly={ro}
        vault={vaultApi}
        getToken={getToken}
        pluginRegistry={pluginRegistry}
        defaultPlugins={SHARE_DEFAULT_PLUGINS}
        style={{ height: '100%' }}
      />
    </div>
  )
}

// ── Page shell ────────────────────────────────────────────────────────────────

export function ShareAccessPage({ sharingApi }: { sharingApi: ISharingAPI }) {
  const { token } = useParams<{ token: string }>()
  const location = useLocation()
  const query = new URLSearchParams(location.search)
  const embedMode = query.get('embed') === '1'
  const embedPath = query.get('path') ?? ''
  const [access, setAccess] = useState<AppShareLinkAccess | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    const cacheKey = `share_access:${token}`
    const cached = sessionStorage.getItem(cacheKey)
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as AppShareLinkAccess
        setAccess(parsed)
        setLoading(false)
      } catch {
        // ignore cache parse errors
      }
    }
    sharingApi.accessShareLink(token)
      .then(dto => {
        setAccess(dto)
        sessionStorage.setItem(cacheKey, JSON.stringify(dto))
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))
  }, [token, sharingApi])

  if (loading) return <FullPage><Status>Vérification du lien…</Status></FullPage>
  if (error)   return <FullPage><Status error>Lien invalide ou expiré. ({error})</Status></FullPage>
  if (!access) return null

  if (embedMode) {
    return (
      <FullPage>
        {access.resourceType === 'vault'
          ? <VaultShareEmbedView access={access} embedPath={embedPath} />
          : <DocumentShareView access={access} embedded />
        }
        <EmbedResize />
      </FullPage>
    )
  }

  const ro = readOnly(access.permission)

  return (
    <FullPage>
      {/* Top bar */}
      <div style={{ height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text)' }}>
            {access.resourceType === 'vault' ? 'Vault partagé' : 'Document partagé'}
          </span>
          {access.expiresAt && (
            <span style={{ marginLeft: 10, fontSize: '0.72rem', color: 'var(--text-faint)' }}>
              expire le {new Date(access.expiresAt).toLocaleString()}
            </span>
          )}
        </div>
        <PermBadge permission={access.permission} readOnly={ro} />
      </div>

      {/* Content */}
      {access.resourceType === 'vault'
        ? <VaultShareView access={access} />
        : <DocumentShareView access={access} />
      }
    </FullPage>
  )
}

function EmbedResize() {
  useEffect(() => {
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const sendResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        const height = Math.max(document.documentElement.scrollHeight, 100)
        window.parent.postMessage({ type: 'module:resize', height }, '*')
      }, 60)
    }
    const ro = new ResizeObserver(sendResize)
    ro.observe(document.documentElement)
    sendResize()
    return () => {
      ro.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
    }
  }, [])
  return null
}

// ── Tiny helpers ──────────────────────────────────────────────────────────────

function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--bg-base)', color: 'var(--text)', fontFamily: 'var(--font-ui)' }}>
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

function PermBadge({ readOnly: ro }: { permission: string; readOnly: boolean }) {
  const bg = ro ? 'rgba(37,99,235,0.12)' : 'rgba(21,128,61,0.15)'
  const color = ro ? 'var(--color-info)' : 'var(--color-success)'
  return (
    <span style={{ fontSize: '0.68rem', padding: '2px 8px', borderRadius: 10, background: bg, color, fontWeight: 600 }}>
      {ro ? 'Lecture seule' : 'Édition'}
    </span>
  )
}
