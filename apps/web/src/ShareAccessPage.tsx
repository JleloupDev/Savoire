// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ShareAccessPage — public page accessible via a share link.
// Exchanges the share token for a SharedDocumentHandle (CRDT + metadata),
// then renders the document as read-only or editable according to the permission.

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { DocumentView } from '@savoire/editor-core'
import { PluginAPIImpl, PluginLoader } from '@savoire/plugin-runtime'
import type { VaultAPI, VaultPlugin } from '@savoire/plugin-api'
import { resolveLinkPath } from '@savoire/plugin-api'
import { createIconElement } from '@savoire/ui-components'
import type { ISharingAPI, SharedDocumentEntry, SharedDocumentHandle } from '@savoire/application'
import { LocalKeyProvider } from '@savoire/infrastructure-sync'
import { pluginRegistry } from './pluginRegistry'
import { useNoteEditorModeOr, type NoteEditorMode } from './displayPreferences'
import { EditorModeSwitch } from './EditorModeSwitch'
import { createWikilinksPlugin } from '@savoire/plugin-wikilinks'
import excalidrawPlugin from '@savoire/plugin-excalidraw'
import mindmapPlugin from '@savoire/plugin-mindmap'
import calloutPlugin from '@savoire/plugin-callout'
import codeBlockPlugin from '@savoire/plugin-code-block'
import taskListPlugin from '@savoire/plugin-task-list'
import noteEmbedPlugin from '@savoire/plugin-note-embed'
import modulePlugin from '@savoire/plugin-module'
import mermaidPlugin from '@savoire/plugin-mermaid'
import tablePlugin from '@savoire/plugin-table'

/** Les plugins d'un document partage, d'apres son chemin (l'application : ceux du module). */
export type SharePluginLoader = (path: string) => Promise<{ editor: VaultPlugin[]; fileTypes: VaultPlugin[] }>

/** Sans chargeur fourni : les plugins de base. */
const basePlugins: SharePluginLoader = async () => ({
  editor: [mermaidPlugin, calloutPlugin, codeBlockPlugin, noteEmbedPlugin, modulePlugin, taskListPlugin, tablePlugin],
  fileTypes: [excalidrawPlugin, mindmapPlugin],
})

/**
 * Le texte et l'arbre partages du document, pour les editeurs CRDT des
 * plugins (discussion, base, page, plan...) : le meme document que celui que
 * le lien synchronise. Sans eux, ces editeurs ne s'ouvraient pas par un lien.
 */
export function crdtViewsOf(crdt: unknown): { openText?: () => import('@savoire/plugin-api').ISharedText; openTree?: () => import('@savoire/plugin-api').ISharedTree } {
  const c = crdt as { sharedText?: () => import('@savoire/plugin-api').ISharedText; sharedTree?: () => import('@savoire/plugin-api').ISharedTree }
  return {
    openText: typeof c.sharedText === 'function' ? () => c.sharedText!() : undefined,
    openTree: typeof c.sharedTree === 'function' ? () => c.sharedTree!() : undefined,
  }
}

/** Nom d'un invite (lien de partage, sans compte) : dans les discussions, les versions... */
export const GUEST_NAME = 'Invité'

/** Identifiant d'un invite : stable pour un lien (le meme invite d'un message a l'autre). */
function guestId(handle: SharedDocumentHandle): string {
  return `share:${handle.docId.slice(0, 8)}`
}

/** Le document du lien que vise un lien `[[...]]` ou un chemin. */
export function sharedDocumentFor(handle: Pick<SharedDocumentHandle, 'documents'>, target: string): SharedDocumentEntry | undefined {
  const paths = handle.documents.flatMap(d => d.path ? [d.path] : [])
  const path = paths.includes(target) ? target : resolveLinkPath(target, paths)
  return path ? handle.documents.find(d => d.path === path) : undefined
}

function createShareVault(handle: SharedDocumentHandle): VaultAPI {
  const paths = (): string[] => {
    const all = handle.documents.flatMap(d => d.path ? [d.path] : [])
    return all.includes(handle.path) ? all : [handle.path, ...all]
  }
  return {
    read:                (id) => Promise.reject(new Error(`read(${id}) not supported on shared document: content is delivered via CRDT`)),
    readDocumentByPath:  (path) => Promise.reject(new Error(`readDocumentByPath(${path}) not supported on shared document: only the shared file is accessible`)),
    write:               () => Promise.resolve(),
    // Les documents que le lien ouvre (la page, ses sous-pages ou ses pages liees).
    list:                () => Promise.resolve(paths()),
    exists:              (id) => Promise.resolve(id === handle.docId || handle.documents.some(d => d.id === id)),
    resolveDocumentId:   (path) => path === handle.path ? handle.docId : sharedDocumentFor(handle, path)?.id,
    getVaultId:          () => handle.vaultId,
    getToken:            () => handle.accessToken,
    // Le fichier partage lui-meme (PDF, Word...) : ses octets, pour son apercu.
    readBinary:          (path) => path === handle.path && handle.attachments
      ? handle.attachments.ownBytes()
      : Promise.resolve(null),
    // Les images que le lien ouvre (sous-pages, pages liees), puis celles
    // rangees avec la note.
    resolveAttachmentUrl: (target) => {
      const shared = sharedDocumentFor(handle, target)
      if (shared && handle.attachments) return handle.attachments.urlOf(shared.id)
      return handle.attachments?.url(target)
        ?? Promise.reject(new Error(`resolveAttachmentUrl(${target}): aucune image lisible par ce lien`))
    },
  }
}

// ── ShareDocumentEditor ───────────────────────────────────────────────────────

function ShareDocumentEditor({ handle, loadPlugins, mode, registry, onOpen }: { handle: SharedDocumentHandle; loadPlugins: SharePluginLoader; mode: NoteEditorMode; registry: PluginRegistry; onOpen: (docId: string) => void }) {
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
      // Les icones des plugins (sinon leur nom s'affiche en texte).
      pluginApi.icons = { create: (name, options) => createIconElement(name, options) }
      // Un lien vers une autre page du partage l'ouvre ici ; les autres ne menent nulle part.
      if (pluginApi.workspace) {
        pluginApi.workspace.openFile = async (target: string) => {
          const doc = sharedDocumentFor(handle, target)
          if (doc && doc.id !== handle.docId) onOpen(doc.id)
        }
      }
      loader = new PluginLoader()
      const plugins = await loadPlugins(handle.path)
      const defaultPlugins: VaultPlugin[] = [createWikilinksPlugin(), ...plugins.editor]
      for (const p of plugins.fileTypes) await loader.loadInternal(p, pluginApi)
      for (const p of defaultPlugins) await loader.loadInternal(p, pluginApi)
      if (cancelled) { await loader.unloadAll(); return }
      view = new DocumentView({
        path: handle.path,
        container,
        vault,
        fileTypeRegistry: pluginApi.files,
        vaultId: handle.vaultId,
        docId: handle.docId,
        userId: guestId(handle),
        userName: GUEST_NAME,
        readOnly: ro,
        editorMode: mode,
        crdt: handle.crdt,
        ...crdtViewsOf(handle.crdt),
        getTransportState: () => handle.transport.getState(),
        pluginAPI: pluginApi,
        defaultPlugins,
        pluginRegistry: registry,
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
    // Pas de `mode` ici : un changement de mode rouvre le lien, donc un
    // nouveau `handle` (l'editeur detruit son document en partant).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handle, ro, loadPlugins])

  return (
    <div
      ref={containerRef}
      // Le conteneur defile, comme dans l'appli (sinon la note est coupee).
      style={{ height: '100%', overflow: 'auto' }}
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

/** Plugins chargeables a la demande, par id : ceux qu'une note declare dans ses proprietes. */
export type PluginRegistry = Record<string, () => Promise<VaultPlugin>>

export function ShareAccessPage({ sharingApi, loadPlugins = basePlugins, registry = pluginRegistry }: { sharingApi: ISharingAPI; loadPlugins?: SharePluginLoader; registry?: PluginRegistry }) {
  const { token } = useParams<{ token: string }>()
  const [handle, setHandle] = useState<SharedDocumentHandle | null>(null)
  const [info, setInfo] = useState<{ filename: string; path: string; permission: SharedDocumentHandle['permission']; docId: string; documents: SharedDocumentEntry[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Un invite n'a souvent rien choisi : mode classique (tableaux, callouts
  // modifiables tels quels), sinon le mode qu'il a choisi.
  const mode = useNoteEditorModeOr('classic')
  // Le document ouvert du lien (une sous-page, une page liee), dans l'adresse.
  const [searchParams, setSearchParams] = useSearchParams()
  const docId = searchParams.get('doc') ?? undefined
  const openDoc = useCallback((id: string) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('doc', id)
      return next
    })
  }, [setSearchParams])

  useEffect(() => {
    if (!token) return
    let disposed = false
    let activeHandle: SharedDocumentHandle | null = null

    // Changer de mode remonte l'editeur, qui detruit le document en partant :
    // on rouvre alors le lien (document neuf). L'en-tete reste affiche.
    setHandle(null)
    const keyProvider = new LocalKeyProvider()
    keyProvider.init()
      .then(() => docId ? sharingApi.openSharedDocument(token, keyProvider, docId) : sharingApi.openSharedDocument(token, keyProvider))
      .then(h => {
        if (disposed) { h.dispose(); return }
        activeHandle = h
        setHandle(h)
        setInfo({ filename: h.filename, path: h.path, permission: h.permission, docId: h.docId, documents: h.documents ?? [] })
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false))

    return () => { disposed = true; activeHandle?.dispose() }
  }, [token, sharingApi, mode, docId])

  if (loading) return <FullPage><Status>Vérification du lien…</Status></FullPage>
  if (error)   return <FullPage><Status error>Lien invalide ou expiré. ({error})</Status></FullPage>
  if (!info) return null

  const ro = info.permission === 'read'
  // Integre dans un autre site (module) : le document seul, sans en-tete.
  const embedded = new URLSearchParams(window.location.search).get('embed') === '1'
  if (embedded) {
    return (
      <FullPage>
        <div data-testid="share-embed" style={{ flex: 1, overflow: 'hidden' }}>
          {handle && <ShareDocumentEditor handle={handle} loadPlugins={loadPlugins} mode={mode} registry={registry} onOpen={openDoc} />}
        </div>
      </FullPage>
    )
  }

  return (
    <FullPage>
      <div style={{ height: 56, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text)' }}>
            {info.filename}
          </span>
          {info.permission && (
            <PermBadge readOnly={ro} />
          )}
        </div>
        {/\.md$/i.test(info.path) && <EditorModeSwitch value={mode} />}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {info.documents.length > 1 && <SharedPages documents={info.documents} current={info.docId} onOpen={openDoc} />}
        <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        {handle && <ShareDocumentEditor handle={handle} loadPlugins={loadPlugins} mode={mode} registry={registry} onOpen={openDoc} />}
        </div>
      </div>
    </FullPage>
  )
}

/** Les pages du lien (sous-pages, pages liees), pour passer de l'une a l'autre. */
function SharedPages({ documents, current, onOpen }: { documents: SharedDocumentEntry[]; current: string; onOpen: (id: string) => void }) {
  const shown = documents.filter(d => d.path)
  return (
    <nav data-testid="share-pages" aria-label="Pages partagées" style={{ width: 240, flexShrink: 0, overflow: 'auto', borderRight: '1px solid var(--border)', background: 'var(--bg-surface)', padding: '8px 0', fontSize: '0.82rem' }}>
      {shown.map(d => {
        const path = d.path!
        const depth = path.split('/').length - (shown[0]?.path?.split('/').length ?? 1)
        const name = (path.split('/').at(-1) ?? path).replace(/\.(md|page)$/i, '')
        const active = d.id === current
        return (
          <button
            key={d.id}
            data-testid="share-page"
            data-doc-id={d.id}
            title={path}
            onClick={() => { if (!active) onOpen(d.id) }}
            style={{
              display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: active ? 'default' : 'pointer',
              padding: `4px 12px 4px ${12 + Math.max(0, depth) * 12}px`, background: active ? 'var(--bg-hover, rgba(127,109,242,0.12))' : 'transparent',
              color: active ? 'var(--text)' : 'var(--text-muted)', fontWeight: active ? 600 : 400,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'inherit', fontSize: 'inherit',
            }}
          >
            {name}
          </button>
        )
      })}
    </nav>
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
