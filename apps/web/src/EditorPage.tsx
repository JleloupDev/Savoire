// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { CrdtDocumentFetcher, RestDocumentFetcher, RestVaultStorage, DocumentRoomClient } from '@savoire/infrastructure-sync'
import { VaultClient, DocumentStore } from '@savoire/platform'
import { WorkspaceRoot } from '@savoire/workspace'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import type { VaultBrowserRefs } from '@savoire/plugin-vault-browser'
import type { VaultAPI } from '@savoire/plugin-api'
import { PluginLoader } from '@savoire/plugin-runtime'
import type { EditorAreaRefs } from './EditorAreaWidget'
import type { VaultSummary, DocumentDto, AccountEntry } from './types'
import { SharingPanel } from './SharingPanel'
import { SettingsPanel, initTheme } from './SettingsWidget'
import { createWebAppRoot } from './createWebAppRoot'
import { QuickOpenModal } from './QuickOpenModal'
import { usePluginBootstrap } from './usePluginBootstrap'

initTheme()

// ── Icon button ───────────────────────────────────────────────────────────────

function IconBtn({ onClick, children, title }: { onClick: () => void; children: React.ReactNode; title?: string }) {
  return (
    <button onClick={onClick} title={title} style={{ padding: '3px 10px', background: 'var(--bg-elevated)', color: 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 12, fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: 5 }}>
      {children}
    </button>
  )
}

function toDocumentDto(doc: { id: string; path: string }): DocumentDto {
  return {
    id: doc.id,
    path: doc.path,
    title: null,
    hash: '',
    sizeBytes: 0,
    createdAt: '',
    updatedAt: '',
  }
}

// ── Main editor page ──────────────────────────────────────────────────────────

export function EditorPage() {
  const { token, accounts, activeAccount, logout, switchAccount } = useAuth()
  const navigate = useNavigate()

  const tokenRef = useRef<string | null>(token)
  tokenRef.current = token
  const activeAccountRef = useRef<typeof activeAccount>(activeAccount)
  activeAccountRef.current = activeAccount

  // ── Infrastructure singletons ──────────────────────────────────────────────

  const documentFetcher = useRef(new CrdtDocumentFetcher({
    getToken: () => tokenRef.current,
    getUserId: () => activeAccountRef.current?.userId ?? 'reader',
  }))
  const restFetcher = useRef(new RestDocumentFetcher())
  const vaultStorage = useRef(new RestVaultStorage())
  const documentStore = useRef(new DocumentStore(documentFetcher.current, restFetcher.current))
  const roomClient = useRef(new DocumentRoomClient({
    getToken: () => tokenRef.current,
  }))
  const managerRef = useRef<WorkspaceManagerImpl | null>(null)

  const appRootRef = useRef(createWebAppRoot({
    documentStore: documentStore.current,
    getToken: () => tokenRef.current,
  }))
  const application = appRootRef.current.api

  // ── Vault state ────────────────────────────────────────────────────────────

  const [activeDoc, setActiveDoc] = useState<DocumentDto | null>(null)
  const [vaults, setVaults] = useState<VaultSummary[]>([])
  const [selectedVault, setSelectedVault] = useState<VaultSummary | null>(null)
  const [documents, setDocuments] = useState<DocumentDto[]>([])

  const [accountSwitcherOpen, setAccountSwitcherOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sharingOpen, setSharingOpen] = useState(false)
  const [markdownEditorMode, setMarkdownEditorMode] = useState<'source' | 'rich'>('source')
  const [quickOpenVisible, setQuickOpenVisible] = useState(false)

  useEffect(() => { if (!token) navigate('/login') }, [token, navigate])

  // ── Stable refs ────────────────────────────────────────────────────────────

  const documentsRef = useRef<DocumentDto[]>(documents)
  documentsRef.current = documents

  const selectedVaultRef = useRef<VaultSummary | null>(selectedVault)
  selectedVaultRef.current = selectedVault

  const vaultsRef = useRef<VaultSummary[]>(vaults)
  vaultsRef.current = vaults

  const selectedVaultIdRef = useRef<string | null>(selectedVault?.id ?? null)
  selectedVaultIdRef.current = selectedVault?.id ?? null

  const vaultAPIRef = useRef<VaultClient | undefined>(undefined)

  const markdownEditorModeRef = useRef<'source' | 'rich'>(markdownEditorMode)
  markdownEditorModeRef.current = markdownEditorMode

  // Notify open panels only after the mode state has actually been committed.
  useEffect(() => {
    window.dispatchEvent(new Event('markdown-editor-mode-changed'))
  }, [markdownEditorMode])

  // ── Vault proxy — stable VaultAPI that always delegates to current vaultAPIRef ──

  const vaultProxy = useMemo((): VaultAPI => application.workspace.createVaultProxy(
    () => vaultAPIRef.current,
    (path: string): string | undefined => {
      const found = documentsRef.current.find(d => d.path === path || d.path === `${path}.md`)
      if (!found) console.warn(`[EditorPage] resolveDocId("${path}") — not found in ${documentsRef.current.length} docs:`, documentsRef.current.map(d => d.path))
      return found?.id
    },
  ), [application.workspace])

  // ── Vault CRUD callbacks (exposed via refs to VaultBrowserWidget) ──────────

  const switchChainRef = useRef<Promise<void>>(Promise.resolve())
  const lastSwitchTsRef = useRef(0)

  // ── Plugin bootstrap ───────────────────────────────────────────────────────

  // editorAreaRefsHolder is populated below (after plugin refs are available).
  // onBeforeReady reads it lazily — it fires after React completes the render.
  const editorAreaRefsHolder = useRef<EditorAreaRefs | null>(null)

  const onSelectVaultRef = useRef<(vault: VaultSummary) => void>(() => {})
  const onCreateVaultRef = useRef<(name: string) => Promise<void>>(async () => {})
  const onRenameVaultRef = useRef<(vault: VaultSummary, name: string) => Promise<void>>(async () => {})
  const onAddMemberRef = useRef<(vault: VaultSummary, userId: string, role: string) => Promise<void>>(async () => {})
  const onDeleteVaultRef = useRef<(vault: VaultSummary) => Promise<void>>(async () => {})

  // All values are useRef objects — stable, so useMemo([]) is correct.
  const vaultBrowserRefs: VaultBrowserRefs<VaultSummary> = useMemo(() => ({
    vaults: vaultsRef,
    selectedVaultId: selectedVaultIdRef,
    onSelectVault: onSelectVaultRef,
    onCreateVault: onCreateVaultRef,
    onRenameVault: onRenameVaultRef,
    onDeleteVault: onDeleteVaultRef,
    onAddMember: onAddMemberRef,
  }), [])

  const {
    onBeforeReady,
    pluginAPIRef,
    defaultPluginsRef,
    fileTypeRegistryRef,
    onControllerReadyRef,
    contentIndexingServiceRef,
    graphContributorRef,
    pluginLoaderRef,
    triggersRef,
  } = usePluginBootstrap({
    roomClient: roomClient.current,
    vaultProxy,
    managerRef,
    vaultBrowserRefs,
    editorAreaRefsHolder,
  })

  const loadDocumentRef = useRef<(doc: DocumentDto) => Promise<string>>(async () => '')
  const refreshDocumentsRef = useRef<() => Promise<DocumentDto[]>>(async () => [])

  // Assemble the ref bag passed into every EditorAreaWidget.
  // All values are useRef objects — stable, so useMemo([]) is correct.
  editorAreaRefsHolder.current ??= {
    documents: documentsRef,
    loadDocument: loadDocumentRef,
    refreshDocuments: refreshDocumentsRef,
    selectedVault: selectedVaultRef,
    token: tokenRef,
    activeAccount: activeAccountRef,
    vaultAPI: vaultAPIRef,
    onControllerReady: onControllerReadyRef,
    fileTypeRegistry: fileTypeRegistryRef,
    defaultPlugins: defaultPluginsRef,
    pluginAPI: pluginAPIRef,
    markdownEditorMode: markdownEditorModeRef,
    contentIndexingService: contentIndexingServiceRef,
    createPluginLoader: () => new PluginLoader(),
  }

  // ── Create VaultClient and notify workspace of vault change ────────────────

  const switchToVault = useCallback(async function switchToVault(vault: VaultSummary, tok: string) {
    const now = Date.now()
    const delay = Math.max(0, 350 - (now - lastSwitchTsRef.current))
    lastSwitchTsRef.current = now + delay

    const run = async () => {
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay))
      if (selectedVaultRef.current?.id === vault.id && vaultAPIRef.current) {
        // see ADR-010
        vaultAPIRef.current.setToken(tok)
        return
      }

      await application.documents.disposeActiveVault()
      setSelectedVault(vault)
      setActiveDoc(null)
      setDocuments([])

      const onChanged = () => {
        const client = application.documents.getActiveClient()
        if (!client) return
        const cached = client.documents
        setDocuments(cached.map(toDocumentDto))
        managerRef.current?.notifyVaultChange()
      }

      const active = await application.documents.activateVault({
        vaultId: vault.id,
        token: tok,
        storage: vaultStorage.current,
        documentStore: documentStore.current,
        resolveDoc: (path) => documentsRef.current.find(d => d.path === path || d.path === path + '.md'),
        onChanged,
      })
      vaultAPIRef.current = active.client
      onChanged()

      // Connect index sync to the new vault hub
      contentIndexingServiceRef.current?.attachHub(() => application.documents.getActiveHub())

      if (graphContributorRef.current) {
        const contributor = graphContributorRef.current
        fetch(`/api/v1/vaults/${vault.id}/links`, {
          headers: { Authorization: `Bearer ${tok}` },
        })
          .then(r => r.ok ? r.json() : [])
          .then((links: Array<{ sourceId: string; sourcePath: string; targetId: string | null; targetPath: string; linkType: string }>) => {
            contributor.bulkLoad(links)
            managerRef.current?.notifyDocumentIndexed('', '')
          })
          .catch(err => console.warn('[GraphPlugin] preload links failed', err))
      }
    }

    switchChainRef.current = switchChainRef.current.then(run).catch((err) => {
      console.error('[EditorPage] switchToVault failed', err)
    })
    await switchChainRef.current
  // switchToVault only uses stable refs (lastSwitchTsRef, selectedVaultRef, vaultAPIRef,
  // vaultStorage, documentStore, documentsRef, contentIndexingServiceRef, graphContributorRef,
  // managerRef) and state setters — application.documents is stable (created once in appRootRef).
  }, [application.documents])

  const loadVaults = useCallback(async () => {
    const account = activeAccount ?? accounts[0] ?? null
    if (!token || !account) return
    try {
      const list = await application.vaults.list(account.userId, token)
      setVaults(list)
      vaultsRef.current = list // sync ref before notify so VaultBrowserPanel.sync() reads fresh data
      managerRef.current?.notifyVaultChange()
      if (list.length === 1) void switchToVault(list[0], token)
    } catch (err) {
      console.error(err)
    }
  }, [token, activeAccount, accounts, application.vaults, switchToVault])

  // Load vaults on mount / auth changes
  useEffect(() => {
    void loadVaults()
  }, [loadVaults])

  // ── loadDocument — fetches content, updates topbar ─────────────────────────

  loadDocumentRef.current = useCallback(async (doc: DocumentDto): Promise<string> => {
    if (!selectedVault || !token) return ''
    if (activeDoc) application.documentSession.close(selectedVault.id, activeDoc.id)
    const opened = await application.documentSession.open(selectedVault.id, doc.id, doc, token)
    setActiveDoc(doc)
    // Push the CRDT content so plugins (backlinks…) can read it via getActiveDocument().content
    managerRef.current?.setActiveDocumentContent(opened)
    return opened
  }, [selectedVault, token, activeDoc, application.documentSession])

  refreshDocumentsRef.current = useCallback(async (): Promise<DocumentDto[]> => {
    if (!selectedVault || !token) return []
    const docs = await application.documents.list(selectedVault.id, token)
    const mapped = docs.map(toDocumentDto)
    setDocuments(mapped)
    return mapped
  }, [selectedVault, token, application.documents])

  // ── Vault CRUD callbacks ───────────────────────────────────────────────────

  onSelectVaultRef.current = (vault: VaultSummary) => {
    if (!token) return
    void switchToVault(vault, token)
  }

  onCreateVaultRef.current = async (name: string) => {
    if (!token || !activeAccount) return
    const vault = await application.vaults.create(activeAccount.userId, name, token)
    setVaults(v => [...v, vault])
    vaultsRef.current = [...vaultsRef.current, vault]
    await switchToVault(vault, token)
  }

  onRenameVaultRef.current = async (vault: VaultSummary, name: string) => {
    if (!token) throw new Error('no token')
    const updated = await application.vaults.rename(vault.id, name, token)
    setVaults(vs => vs.map(v => v.id === vault.id ? { ...v, name: updated.name } : v))
    if (selectedVault?.id === vault.id) setSelectedVault(sv => sv ? { ...sv, name: updated.name } : sv)
  }

  onAddMemberRef.current = async (vault: VaultSummary, userId: string, role: string) => {
    if (!token) throw new Error('no token')
    await application.vaults.addMember(vault.id, userId, role, token)
  }

  onDeleteVaultRef.current = async (vault: VaultSummary) => {
    if (!token) throw new Error('no token')
    await application.vaults.delete(vault.id, token)
    const filtered = vaultsRef.current.filter(v => v.id !== vault.id)
    setVaults(filtered)
    vaultsRef.current = filtered
    if (selectedVault?.id === vault.id) {
      await application.documents.disposeActiveVault()
      vaultAPIRef.current = undefined
      setSelectedVault(null); setDocuments([]); setActiveDoc(null)
      managerRef.current?.notifyVaultChange()
    }
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  // handleNewNote only uses stable refs (vaultAPIRef, managerRef) — no reactive deps needed.
  const handleNewNote = useCallback(async () => {
    const vaultApi = vaultAPIRef.current
    if (!vaultApi) return
    let name = 'Untitled.md'
    let i = 1
    const existing = vaultApi.documents.map(d => d.path)
    while (existing.includes(name)) { name = `Untitled-${i++}.md` }
    try {
      await vaultApi.createFile(name)
      void managerRef.current?.openFile(name)
    } catch (err) {
      console.error('[Ctrl+N]', err)
    }
  }, [])

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Ctrl+N is reserved by the browser (new window) and cannot be overridden.
      // Ctrl+Alt+N is the standard alternative for "new file" in web editors.
      if (e.ctrlKey && e.altKey && !e.shiftKey && e.key === 'n') {
        e.preventDefault()
        void handleNewNote()
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === 'o') {
        e.preventDefault()
        setQuickOpenVisible(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [handleNewNote])

  // ── Account ────────────────────────────────────────────────────────────────

  async function handleSwitchAccount(acc: AccountEntry) {
    setAccountSwitcherOpen(false)
    if (acc.userId === activeAccount?.userId) return
    const ok = await switchAccount(acc.userId)
    if (ok) {
      await application.documents.disposeActiveVault()
      vaultAPIRef.current = undefined
      setSelectedVault(null); setVaults([]); setDocuments([]); setActiveDoc(null)
      vaultsRef.current = []
      managerRef.current?.notifyVaultChange()
    }
  }

  async function handleLogout() {
    setAccountSwitcherOpen(false)
    await logout(); navigate('/login')
  }

  // ── Plugin unload on unmount ───────────────────────────────────────────────

  useEffect(() => {
    return () => {
      // In local dev, React StrictMode + HMR can cause aggressive mount/unmount cycles.
      // Avoid unload/reload thrash there; keep full cleanup outside localhost.
      const host = typeof window !== 'undefined' ? window.location.hostname : ''
      const isLocalDevHost = host === 'localhost' || host === '127.0.0.1'
      if (!isLocalDevHost) void pluginLoaderRef.current.unloadAll()
    }
  }, [pluginLoaderRef])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg-base)', color: 'var(--text)', fontFamily: 'var(--font-ui)', flexDirection: 'column' }}>

      {/* ── Topbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)', minHeight: 42, flexShrink: 0, gap: 8 }}>
        <span style={{ fontSize: '0.88rem', fontWeight: 600, color: activeDoc ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
          {activeDoc ? `${selectedVault?.name} / ${activeDoc.path}` : selectedVault ? selectedVault.name : '— Sélectionner un vault —'}
        </span>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>

          {/* Account switcher */}
          <div style={{ position: 'relative' }}>
            <IconBtn onClick={() => setAccountSwitcherOpen(o => !o)} title="Comptes">
              <span>👤</span><span>{activeAccount?.displayName ?? 'Non connecté'}</span>
            </IconBtn>
            {accountSwitcherOpen && (
              <div style={{ position: 'absolute', top: 34, right: 0, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 4, display: 'flex', flexDirection: 'column', gap: 2, zIndex: 999, minWidth: 190, boxShadow: 'var(--shadow)' }}>
                {accounts.map(acc => (
                  <button key={acc.userId} onClick={() => void handleSwitchAccount(acc)} style={{ textAlign: 'left', padding: '5px 10px', border: 'none', borderRadius: 4, fontSize: '0.78rem', background: acc.userId === activeAccount?.userId ? 'var(--bg-elevated)' : 'transparent', color: acc.userId === activeAccount?.userId ? 'var(--color-success)' : 'var(--text)' }}>
                    {acc.displayName}
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginLeft: 4 }}>{acc.email}</span>
                  </button>
                ))}
                <div style={{ borderTop: '1px solid var(--border)', margin: '2px 0' }} />
                <button onClick={() => { setAccountSwitcherOpen(false); void navigate('/admin') }} style={{ textAlign: 'left', padding: '5px 10px', border: 'none', borderRadius: 4, fontSize: '0.78rem', background: 'transparent', color: 'var(--color-info)' }}>⚙ Administration</button>
                <button onClick={() => void handleLogout()} style={{ textAlign: 'left', padding: '5px 10px', border: 'none', borderRadius: 4, fontSize: '0.78rem', background: 'transparent', color: 'var(--color-danger)' }}>✕ Déconnexion</button>
              </div>
            )}
          </div>

          {/* Share */}
          {selectedVault && (
            <IconBtn onClick={() => setSharingOpen(true)} title="Partager">
              <span>🔗</span><span>Partager</span>
            </IconBtn>
          )}

          {/* Settings */}
          <IconBtn onClick={() => setSettingsOpen(true)} title="Paramètres">⚙</IconBtn>

          {/* Markdown editor mode toggle */}
          <IconBtn
            onClick={() => setMarkdownEditorMode(m => (m === 'source' ? 'rich' : 'source'))}
            title="Basculer l'éditeur Markdown"
          >
            <span>{markdownEditorMode === 'source' ? 'CM6' : 'Rich'}</span>
          </IconBtn>
        </div>
      </div>

      {/* ── Workspace — always rendered, never remounts ── */}
      <WorkspaceRoot
        vault={vaultProxy}
        fileTypesRef={fileTypeRegistryRef}
        onBeforeReady={onBeforeReady}
        onReady={(m) => { managerRef.current = m; m.notifyVaultChange() }}
        style={{ flex: 1, overflow: 'hidden' }}
      />

      {accountSwitcherOpen && (
        <div onClick={() => setAccountSwitcherOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 998 }} />
      )}

      {/* ── Settings modal ── */}
      {settingsOpen && (
        <>
          <div onClick={() => setSettingsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.5)' }} />
          <div style={{ position: 'fixed', inset: '5vh 10vw', zIndex: 1001, borderRadius: 12, overflow: 'hidden', boxShadow: '0 24px 80px rgba(0,0,0,0.5)', border: '1px solid var(--border)' }}>
            <SettingsPanel loader={pluginLoaderRef.current} triggers={triggersRef.current ?? { register: () => {}, unregister: () => {}, getAll: () => [], findConflict: () => undefined }} />
            <button onClick={() => setSettingsOpen(false)} style={{ position: 'absolute', top: 12, right: 16, background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer', zIndex: 1 }}>✕</button>
          </div>
        </>
      )}

      {sharingOpen && token && selectedVault && (
        <SharingPanel
          token={token}
          vault={selectedVault}
          document={activeDoc}
          onClose={() => setSharingOpen(false)}
        />
      )}

      {/* ── QuickOpen modal (Ctrl+O) ── */}
      {quickOpenVisible && (
        <QuickOpenModal
          documents={documents}
          onSelect={(path) => { void managerRef.current?.openFile(path) }}
          onClose={() => setQuickOpenVisible(false)}
        />
      )}
    </div>
  )
}
