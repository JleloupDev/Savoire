// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from './AuthContext'
import { useVaultKey } from './VaultKeyContext'
import { VaultKeyGate } from './VaultKeyGate'
import { VaultClient, DocumentStore, ServerIndexStorage } from '@savoire/platform'
import { YMapVaultDirectory } from '@savoire/infrastructure-sync'
import { getVaultLockProbe } from './vaultLock'
import type { EdgesyncVaultSessionLike } from '@savoire/application'
import { WorkspaceRoot } from '@savoire/workspace'
import type { WorkspaceManagerImpl } from '@savoire/workspace'
import type { VaultBrowserRefs } from '@savoire/plugin-vault-browser'
import type { VaultAPI, ISeedExportingIdentityProvider, IIdentityProvider } from '@savoire/plugin-api'
import { PluginLoader } from '@savoire/plugin-runtime'
import type { EditorAreaRefs } from './EditorAreaWidget'
import type { VaultSummary, SharedNote, DocumentDto, AccountEntry } from './types'
import { SharingPanel } from './SharingPanel'
import { VaultKeyDebugPanel } from './VaultKeyDebugPanel'
import { SettingsPanel, initTheme } from './SettingsWidget'
import { createWebAppRoot, createWebInfrastructure } from './createWebAppRoot'
import { QuickOpenModal } from './QuickOpenModal'
import { usePluginBootstrap } from './usePluginBootstrap'
import { RibbonIcon, SettingsIcon, RailLogoSvg } from './icons'
import { t, getLocale, setLocale, subscribeLocale } from '@savoire/i18n'
import type { Locale } from '@savoire/i18n'
import { notify } from '@savoire/notifications'

initTheme()

// ── Icon rail ─────────────────────────────────────────────────────────────────

import type { RibbonItem } from '@savoire/workspace'

function IconRail({ ribbonItems, activeViewId, onRibbonClick, onSettingsClick, onQuickOpen, activeAccount, accounts, onSwitchAccount, onAdmin, onManageKey, onLogout }: {
  ribbonItems: RibbonItem[]
  activeViewId: string | null
  onRibbonClick: (item: RibbonItem) => void
  onSettingsClick: () => void
  onQuickOpen: () => void
  activeAccount: AccountEntry | null
  accounts: AccountEntry[]
  onSwitchAccount: (acc: AccountEntry) => void
  onAdmin: () => void
  onManageKey: () => void
  onLogout: () => void
}) {
  const [avatarOpen, setAvatarOpen] = useState(false)

  const railBtn = (item: RibbonItem) => {
    const isActive = activeViewId !== null && (
      item.type === 'group'
        ? item.id === activeViewId  // approximate: set by manager on group toggle
        : item.id === activeViewId
    )
    return (
      <button
        key={item.id}
        title={item.title}
        onClick={() => onRibbonClick(item)}
        style={{
          width: 40, height: 40,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          border: 'none', borderRadius: 8,
          background: isActive ? 'var(--accent-dim)' : 'transparent',
          color: isActive ? 'var(--accent)' : 'var(--text-faint)',
          cursor: 'pointer',
          transition: 'background 0.12s, color 0.12s',
          margin: '0 4px',
        }}
        onMouseEnter={e => { if (!isActive) { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)' } }}
        onMouseLeave={e => { if (!isActive) { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)' } }}
      >
        <RibbonIcon name={item.icon} />
      </button>
    )
  }

  const leftItems  = ribbonItems.filter(i => i.container === 'left')
  const rightItems = ribbonItems.filter(i => i.container === 'right')

  return (
    <div style={{
      width: 48, background: 'var(--rail)', borderRight: '1px solid var(--rail-border)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between',
      flexShrink: 0, paddingTop: 8, paddingBottom: 8, zIndex: 10,
    }}>
      {/* Top: logo + left-pane ribbon items + right-pane ribbon items */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <div style={{ width: 28, height: 28, background: 'var(--accent)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4, cursor: 'default' }}>
          <RailLogoSvg />
        </div>
        <button
          title="Ouverture rapide (Ctrl+O)"
          onClick={onQuickOpen}
          style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer', margin: '0 4px 8px', transition: 'background 0.12s, color 0.12s' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)' }}
        >
          <RibbonIcon name="quick-open" />
        </button>
        {leftItems.map(railBtn)}
        {rightItems.length > 0 && leftItems.length > 0 && (
          <div style={{ width: 24, height: 1, background: 'var(--border)', margin: '4px 0' }} />
        )}
        {rightItems.map(railBtn)}
      </div>

      {/* Bottom: settings + avatar */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
        <button
          title="Paramètres"
          onClick={onSettingsClick}
          style={{ width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', borderRadius: 8, background: 'transparent', color: 'var(--text-faint)', cursor: 'pointer', margin: '0 4px', transition: 'background 0.12s, color 0.12s' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'var(--bg-elevated)'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-muted)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)' }}
        >
          <SettingsIcon />
        </button>

        <div style={{ position: 'relative', marginTop: 2 }}>
          <div
            title={activeAccount?.displayName ?? 'Non connecté'}
            onClick={() => setAvatarOpen(o => !o)}
            style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent-dim)', border: '2px solid var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: 'var(--accent)', fontWeight: 700, cursor: 'pointer', flexShrink: 0, userSelect: 'none' }}
          >
            {activeAccount ? activeAccount.displayName.slice(0, 2).toUpperCase() : '?'}
          </div>

          {avatarOpen && (
            <>
              <div onClick={() => setAvatarOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 998 }} />
              <div style={{ position: 'absolute', bottom: 36, left: 0, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 4, display: 'flex', flexDirection: 'column', gap: 2, zIndex: 999, minWidth: 190, boxShadow: 'var(--shadow)' }}>
                {accounts.map(acc => (
                  <button key={acc.userId} onClick={() => { onSwitchAccount(acc); setAvatarOpen(false) }} style={{ textAlign: 'left', padding: '5px 10px', border: 'none', borderRadius: 4, fontSize: '0.78rem', background: acc.userId === activeAccount?.userId ? 'var(--bg-elevated)' : 'transparent', color: acc.userId === activeAccount?.userId ? 'var(--color-success)' : 'var(--text)', cursor: 'pointer' }}>
                    {acc.displayName}
                    <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginLeft: 4 }}>{acc.email}</span>
                  </button>
                ))}
                <div style={{ borderTop: '1px solid var(--border)', margin: '2px 0' }} />
                <button onClick={() => { onManageKey(); setAvatarOpen(false) }} style={{ textAlign: 'left', padding: '5px 10px', border: 'none', borderRadius: 4, fontSize: '0.78rem', background: 'transparent', color: 'var(--text)', cursor: 'pointer' }}>🔑 Ma clé de chiffrement</button>
                <button onClick={() => { onAdmin(); setAvatarOpen(false) }} style={{ textAlign: 'left', padding: '5px 10px', border: 'none', borderRadius: 4, fontSize: '0.78rem', background: 'transparent', color: 'var(--color-info)', cursor: 'pointer' }}>⚙ Administration</button>
                <button onClick={() => { onLogout(); setAvatarOpen(false) }} style={{ textAlign: 'left', padding: '5px 10px', border: 'none', borderRadius: 4, fontSize: '0.78rem', background: 'transparent', color: 'var(--color-danger)', cursor: 'pointer' }}>✕ Déconnexion</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
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

// What to resume, if anything, once the key modal closes successfully — the
// modal itself doesn't know or care why it was opened (VaultKeyGate.tsx),
// this is purely AppShell's own bookkeeping so entering a working key
// re-attempts the action that got blocked, instead of requiring a manual
// second click (or, before this existed, a full page reload).
type KeyModalRequest =
  | { kind: 'manage' }
  | { kind: 'open-vault'; vault: VaultSummary }
  | { kind: 'create-vault'; name: string }

// ── Main editor page ──────────────────────────────────────────────────────────

export function AppShell() {
  const { token, accounts, activeAccount, isReady, logout, switchAccount } = useAuth()
  const { getVaultKey, clearVaultKey, keyVersion } = useVaultKey()
  const navigate = useNavigate()

  const tokenRef = useRef<string | null>(token)
  tokenRef.current = token
  const activeAccountRef = useRef<typeof activeAccount>(activeAccount)
  activeAccountRef.current = activeAccount

  // ── Infrastructure singletons ──────────────────────────────────────────────

  const infraRef = useRef(createWebInfrastructure(
    () => tokenRef.current,
    () => activeAccountRef.current?.userId ?? 'reader',
  ))
  const { documentFetcher, vaultStorage, roomClient, documentStore } = infraRef.current
  const managerRef = useRef<WorkspaceManagerImpl | null>(null)

  const appRootRef = useRef(createWebAppRoot({
    documentStore: documentStore,
    getToken: () => tokenRef.current,
    getVaultKey: () => {
      const userId = activeAccountRef.current?.userId
      return userId ? getVaultKey(userId) : null
    },
    onConnectionChange: (state) => {
      if (state === 'disconnected') notify('warn', t('app', 'sync.disconnected'))
      else notify('success', t('app', 'sync.reconnected'))
    },
  }))
  const application = appRootRef.current.api

  // Profil EdgeSync uniquement : decide le badge « verrouille » d'un vault, sans
  // jamais ouvrir de session. Undefined en profil serveur — voir vaultLock.ts.
  const vaultLockProbeRef = useRef(getVaultLockProbe())

  // Single source of truth for "get me a usable K_User, or tell me there's
  // none". K_User is memory-only and user-held (VaultKeyGate.tsx): the server
  // never has it, so there is nothing to fetch — an account with no key in
  // memory falls through to null and the caller opens the key modal.
  const resolveVaultKey = useCallback(async (userId: string): Promise<Uint8Array | null> =>
    getVaultKey(userId), [getVaultKey])

  const [keyModalRequest, setKeyModalRequest] = useState<KeyModalRequest | null>(null)

  // ── Vault state ────────────────────────────────────────────────────────────

  const [activeDoc, setActiveDoc] = useState<DocumentDto | null>(null)
  const [vaults, setVaults] = useState<VaultSummary[]>([])
  const [sharedWithMe, setSharedWithMe] = useState<SharedNote[]>([])
  const sharedWithMeRef = useRef<SharedNote[]>(sharedWithMe)
  const [selectedVault, setSelectedVault] = useState<VaultSummary | null>(null)
  const [documents, setDocuments] = useState<DocumentDto[]>([])

  const [ribbonItems, setRibbonItems] = useState<RibbonItem[]>([])
  const [activeViewId, setActiveViewId] = useState<string | null>(null)

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sharingOpen, setSharingOpen] = useState(false)
  const [keyDebugOpen, setKeyDebugOpen] = useState(false)
  const [markdownEditorMode, setMarkdownEditorMode] = useState<'source' | 'rich'>('source')
  const [quickOpenVisible, setQuickOpenVisible] = useState(false)
  const [locale, setLocaleState] = useState<Locale>(getLocale)

  useEffect(() => subscribeLocale(setLocaleState), [])

  useEffect(() => { if (isReady && !token) navigate('/login') }, [isReady, token, navigate])

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
  const edgesyncVaultRef = useRef<EdgesyncVaultSessionLike | undefined>(undefined)
  // Profil serveur : CollabOrchestrator signe chaque op avec cette identité.
  const identityProviderRef = useRef<IIdentityProvider | undefined>(undefined)
  identityProviderRef.current = appRootRef.current.identityProvider

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
  const onDeleteVaultRef = useRef<(vault: VaultSummary) => Promise<void>>(async () => {})
  const onRefreshRef = useRef<() => void>(() => {})
  const isReadOnlyRef = useRef(false)
  isReadOnlyRef.current = selectedVault?.role === 'viewer'
  const onOpenSharedNoteRef = useRef<(note: SharedNote) => void>(() => {})
  const docEventUnsubRef = useRef<(() => void) | null>(null)

  // All values are useRef objects — stable, so useMemo([]) is correct.
  const vaultBrowserRefs: VaultBrowserRefs<VaultSummary> = useMemo(() => ({
    vaults: vaultsRef,
    selectedVaultId: selectedVaultIdRef,
    onSelectVault: onSelectVaultRef,
    onCreateVault: onCreateVaultRef,
    onRenameVault: onRenameVaultRef,
    onDeleteVault: onDeleteVaultRef,
    onRefresh: onRefreshRef,
    sharedWithMe: sharedWithMeRef,
    onOpenSharedNote: onOpenSharedNoteRef,
  }), [])

  const {
    onBeforeReady,
    pluginAPIRef,
    defaultPluginsRef,
    fileTypeRegistryRef,
    onControllerReadyRef,
    contentIndexingServiceRef,
    getGraphContributor,
    pluginLoaderRef,
    triggersRef,
    onCrdtTextChangeRef,
  } = usePluginBootstrap({
    roomClient: roomClient,
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
    edgesyncVault: edgesyncVaultRef,
    identity: identityProviderRef,
    onControllerReady: onControllerReadyRef,
    fileTypeRegistry: fileTypeRegistryRef,
    defaultPlugins: defaultPluginsRef,
    pluginAPI: pluginAPIRef,
    markdownEditorMode: markdownEditorModeRef,
    contentIndexingService: contentIndexingServiceRef,
    createPluginLoader: () => new PluginLoader(),
    isReadOnly: isReadOnlyRef,
    onCrdtTextChange: onCrdtTextChangeRef,
  }

  // ── Create VaultClient and notify workspace of vault change ────────────────

  const switchToVault = useCallback(async function switchToVault(vault: VaultSummary, tok: string) {
    const now = Date.now()
    const delay = Math.max(0, 350 - (now - lastSwitchTsRef.current))
    lastSwitchTsRef.current = now + delay

    const run = async () => {
      if (delay > 0) await new Promise<void>(resolve => setTimeout(resolve, delay))
      if (vaultAPIRef.current?.getVaultId() === vault.id) {
        // see ADR-010. Checked against the CLIENT's own vault id, not
        // selectedVaultRef — selectedVault is set optimistically below,
        // before activateVault is attempted, so it's set to `vault` even
        // when activation goes on to fail (WrongVaultKeyError). Keying off
        // selectedVaultRef here would silently no-op a retry: the vault
        // would look "already selected" while vaultAPIRef.current still
        // points at whatever OTHER vault was last actually opened.
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

      // The vault's shared edgesync Keyring is derived from the same
      // identity used elsewhere (EditorAreaWidget's per-document seam used
      // to do this per-document; now done once per vault activation).
      const provider = appRootRef.current.identityProvider as ISeedExportingIdentityProvider | undefined
      if (!provider) throw new Error('activateVault requires an identity provider')
      await provider.init()
      if (!provider.exportSignSeed) throw new Error('identity provider cannot export a seed')
      const identitySeed = provider.exportSignSeed()

      const active = await application.documents.activateVault({
        vaultId: vault.id,
        token: tok,
        storage: vaultStorage,
        documentStore: documentStore,
        directory: new YMapVaultDirectory(),
        resolveDoc: (path) => documentsRef.current.find(d => d.path === path || d.path === path + '.md'),
        onChanged,
        identitySeed,
      })
      vaultAPIRef.current = active.client
      edgesyncVaultRef.current = active.edgesyncVault
      onChanged()

      // Connect index sync to the new vault hub, then restore its persisted index snapshot.
      contentIndexingServiceRef.current?.attachHub(() => application.documents.getActiveHub())
      await contentIndexingServiceRef.current?.switchVault(new ServerIndexStorage(vault.id, () => tokenRef.current))

      const graphContributor = getGraphContributor()
      if (graphContributor) {
        fetch(`/api/v1/vaults/${vault.id}/links`, {
          headers: { Authorization: `Bearer ${tok}` },
        })
          .then(r => r.ok ? r.json() : [])
          .then((links: Array<{ sourceId: string; sourcePath: string; targetId: string | null; targetPath: string; linkType: string }>) => {
            graphContributor.bulkLoad(links)
            managerRef.current?.notifyDocumentIndexed('', '')
          })
          .catch(err => console.warn('[GraphPlugin] preload links failed', err))
      }
    }

    switchChainRef.current = switchChainRef.current.then(run).catch((err) => {
      if (vaultLockProbeRef.current?.isWrongKeyError(err)) {
        // Distinct from "nothing escrowed yet" (which never throws — see
        // EdgesyncVaultSession.restore()): the server DOES have a wrapped
        // Keyring for this vault, but the K_User currently in memory does not
        // decrypt it. Mark ONLY this vault locked (a key can be right for
        // some vaults and wrong for others — clearing the whole account's
        // key here would be too broad, see plan Decision 6) — the lock-probe
        // effect would reach the same conclusion on its own, this just
        // reflects it immediately instead of waiting for the next probe.
        setVaults(vs => vs.map(v => v.id === vault.id ? { ...v, locked: true } : v))
        vaultsRef.current = vaultsRef.current.map(v => v.id === vault.id ? { ...v, locked: true } : v)
        managerRef.current?.notifyVaultChange() // VaultBrowserPanel only re-syncs from vaultsRef on this notification
        notify('danger', 'Vault verrouillé', 'Cette clé ne correspond pas à ce vault. Ouvre le cadenas pour en essayer une autre.')
        return
      }
      console.error('[EditorPage] switchToVault failed', err)
    })
    await switchChainRef.current
  // switchToVault only uses stable refs (lastSwitchTsRef, selectedVaultRef, vaultAPIRef,
  // vaultStorage, documentStore, documentsRef, contentIndexingServiceRef, getGraphContributor,
  // managerRef) and state setters — application.documents is stable (created once in appRootRef).
  }, [application.documents])

  const loadVaults = useCallback(async () => {
    const account = activeAccount ?? accounts[0] ?? null
    if (!token || !account) return
    try {
      const { vaults: list, sharedWithMe: shared } = await application.vaults.list(account.userId, token)
      // locked starts false — the probe effect (below) fills it in once it
      // has actually checked the server; AppVaultSummary (the API's own DTO
      // shape) has no notion of it at all, see plan Part C.
      const withLocked = list.map(v => ({ ...v, locked: false }))
      setVaults(withLocked)
      setSharedWithMe(shared)
      sharedWithMeRef.current = shared
      vaultsRef.current = withLocked // sync ref before notify so VaultBrowserPanel.sync() reads fresh data
      managerRef.current?.notifyVaultChange()
      if (list.length === 1) void switchToVault(withLocked[0], token)
    } catch (err) {
      console.error(err)
    }
  }, [token, activeAccount, accounts, application.vaults, switchToVault])

  // Load vaults on mount / auth changes
  useEffect(() => {
    void loadVaults()
  }, [loadVaults])

  // ── Lock-probe: which vaults can THIS key actually open? ────────────────────
  // Proactive (not just on click) so the list can show a lock badge before
  // the user ever tries to open anything — see VaultKeyEscrow.fetch(), which
  // already distinguishes "nothing escrowed" (undefined) from "escrowed but
  // this key doesn't decrypt it" (WrongVaultKeyError, including when there's
  // no key at all in memory).
  const probeGenerationRef = useRef(0)
  const vaultIdsKey = vaults.map(v => v.id).sort().join(',')
  useEffect(() => {
    if (!vaultIdsKey) return
    // Profil serveur : pas de sonde, aucun vault n'est verrouille.
    const probe = vaultLockProbeRef.current
    if (!probe) return
    const generation = ++probeGenerationRef.current
    const ids = vaultIdsKey.split(',')
    void (async () => {
      // Each entry always resolves (never rejects) — fetch()'s own errors are
      // caught right here, badge-relevant or not (see comment below).
      const results = await Promise.all(
        ids.map(async (id): Promise<[string, boolean]> => {
          // isLocked() ne rejette jamais : un alea reseau rend `false`, le
          // badge n'est qu'indicatif — l'ouverture reelle reste l'autorite.
          return [id, await probe.isLocked(id)]
        }),
      )
      if (generation !== probeGenerationRef.current) return // a newer probe superseded this one
      const lockedById = new Map(results)
      const applyLocks = (list: VaultSummary[]) =>
        list.map(v => lockedById.has(v.id) ? { ...v, locked: lockedById.get(v.id)! } : v)
      setVaults(applyLocks)
      vaultsRef.current = applyLocks(vaultsRef.current)
      managerRef.current?.notifyVaultChange() // VaultBrowserPanel only re-syncs from vaultsRef on this notification
    })()
  // vaultIdsKey (not `vaults`) is deliberate — this effect's own setVaults
  // above only changes `locked`, never the id set, so depending on `vaults`
  // directly would re-trigger this same effect forever. keyVersion re-runs
  // the probe whenever any account's key changes (cheap enough not to scope
  // more precisely — see plan).
  }, [vaultIdsKey, keyVersion])

  // ── loadDocument — fetches content, updates topbar ─────────────────────────

  loadDocumentRef.current = useCallback(async (doc: DocumentDto): Promise<string> => {
    // Use refs instead of closure values — loadDocumentRef.current is called
    // asynchronously by EditorAreaWidget and may run after activateSharedDocument
    // sets new state but before React re-renders update the closure.
    // see ADR-029
    const vault = selectedVaultRef.current
    const tok = tokenRef.current
    if (!vault || !tok) return ''
    if (activeDoc) application.documentSession.close(vault.id, activeDoc.id)
    const opened = await application.documentSession.open(vault.id, doc.id, doc, tok)
    setActiveDoc(doc)
    // Push the CRDT content so plugins (backlinks…) can read it via getActiveDocument().content
    managerRef.current?.setActiveDocumentContent(opened)
    return opened
  }, [activeDoc, application.documentSession])

  refreshDocumentsRef.current = useCallback(async (): Promise<DocumentDto[]> => {
    if (!selectedVault || !token) return []
    // Documents live in the CRDT vault directory (populated via InitVault / vault ops),
    // not REST. Read the active client's current snapshot.
    const client = application.documents.getActiveClient()
    const mapped = (client?.documents ?? []).map(toDocumentDto)
    setDocuments(mapped)
    return mapped
  }, [selectedVault, token, application.documents])

  // ── Vault CRUD callbacks ───────────────────────────────────────────────────

  onSelectVaultRef.current = (vault: VaultSummary) => {
    if (!token || !activeAccount) return
    if (!vault.locked) { void switchToVault(vault, token); return }
    void resolveVaultKey(activeAccount.userId).then(key => {
      if (key) void switchToVault(vault, token)
      else setKeyModalRequest({ kind: 'open-vault', vault })
    })
  }

  onCreateVaultRef.current = async (name: string) => {
    if (!token || !activeAccount) return
    // A Keyring only survives a reload if SOME key is present to escrow it
    // under (VaultKeyEscrow.save() no-ops without one) — require a key
    // before creating rather than let a vault's content quietly become
    // unrecoverable. Still always "possible to create": the key modal
    // resumes creation automatically once a key is set (handleKeyModalDone).
    if (!await resolveVaultKey(activeAccount.userId)) {
      setKeyModalRequest({ kind: 'create-vault', name })
      return
    }
    const vault = { ...await application.vaults.create(activeAccount.userId, name, token), locked: false }
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

  onRefreshRef.current = () => { void loadVaults() }

  onOpenSharedNoteRef.current = (note: SharedNote) => {
    if (!token) return
    const vault = vaultsRef.current.find(v => v.id === note.vaultId)
    if (vault) {
      void switchToVault(vault, token).then(() => {
        void managerRef.current?.openFile(note.path)
      })
    } else {
      // User has doc-level ACL but is not a vault member.
      // activateSharedDocument creates a stub VaultClient (no vault hub, no
      // listDocuments call) so the editor can open without a 403.
      const docStub = toDocumentDto({ id: note.documentId, path: note.path })
      const stubVault: VaultSummary = {
        id: note.vaultId,
        name: note.path.split('/')[0] ?? note.vaultId,
        role: note.permission === 'read' ? 'viewer' : 'editor',
        documentCount: 1,
        folderCount: 0,
        lastModifiedAt: null,
        sizeBytes: 0,
        locked: false, // shared-document flow never goes through EdgesyncVaultSession/K_User at all
      }

      if (activeDoc && selectedVaultRef.current)
        application.documentSession.close(selectedVaultRef.current.id, activeDoc.id)

      docEventUnsubRef.current?.()
      docEventUnsubRef.current = null

      // Shared documents use the CRDT fetcher: JoinDocument(Read) accepts users
      // holding a document-level permission, so non-vault-members can join the
      // CRDT room and receive content via Yjs (no REST content endpoint needed).
      const sharedDocStore = new DocumentStore(documentFetcher)
      void application.documents.activateSharedDocument({
        vaultId: note.vaultId,
        doc: docStub,
        token,
        documentStore: sharedDocStore,
        directory: new YMapVaultDirectory(),
        resolveDoc: (p) => (p === note.path || p === note.path.replace(/\.md$/, '')) ? docStub : undefined,
      }).then(activated => {
        vaultAPIRef.current = activated.client
        // Shared-document access never gets an edgesync vault session (it's
        // isolated by design — see ADR-027); clear any previous vault's stale ref.
        edgesyncVaultRef.current = undefined
        selectedVaultRef.current = stubVault  // update ref immediately so loadDocumentRef sees it
        setSelectedVault(stubVault)
        setDocuments([docStub])
        // Update the ref immediately — setDocuments schedules a re-render but openFile
        // below calls openPathInCenter synchronously, before React re-renders.
        // Without this, documentsRef.current still holds the previous vault's docs,
        // causing openPathInCenter to fall through to refreshDocuments() → 404.
        documentsRef.current = [docStub]
        setActiveDoc(null)
        managerRef.current?.notifyVaultChange()

        // Subscribe to doc metadata events — the server adds non-members to
        // the doc-events group when JoinDocument runs (triggered by openFile below).
        docEventUnsubRef.current = documentFetcher.subscribeDocumentEvents(note.documentId, {
          onRenamed: (newPath) => {
            setDocuments(ds => ds.map(d => d.id === note.documentId ? { ...d, path: newPath } : d))
            managerRef.current?.notifyVaultChange()
          },
          onDeleted: () => {
            application.documentSession.close(note.vaultId, note.documentId)
            void application.documents.disposeActiveVault()
            docEventUnsubRef.current?.()
            docEventUnsubRef.current = null
            vaultAPIRef.current = undefined
            edgesyncVaultRef.current = undefined
            setActiveDoc(null); setSelectedVault(null); setDocuments([])
            managerRef.current?.notifyVaultChange()
          },
          onAccessRevoked: (targetUserId) => {
            if (targetUserId !== activeAccount?.userId) return
            application.documentSession.close(note.vaultId, note.documentId)
            void application.documents.disposeActiveVault()
            docEventUnsubRef.current?.()
            docEventUnsubRef.current = null
            vaultAPIRef.current = undefined
            edgesyncVaultRef.current = undefined
            setActiveDoc(null); setSelectedVault(null); setDocuments([])
            managerRef.current?.notifyVaultChange()
          },
        })

        void managerRef.current?.openFile(note.path)
      }).catch(err => console.error('[SharedNote] activateSharedDocument failed', err))
    }
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
      edgesyncVaultRef.current = undefined
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
    if (acc.userId === activeAccount?.userId) return
    const ok = await switchAccount(acc.userId)
    if (ok) {
      await application.documents.disposeActiveVault()
      vaultAPIRef.current = undefined
      edgesyncVaultRef.current = undefined
      setSelectedVault(null); setVaults([]); setDocuments([]); setActiveDoc(null)
      vaultsRef.current = []
      managerRef.current?.notifyVaultChange()
    }
  }

  async function handleLogout() {
    const userId = activeAccount?.userId
    await logout()
    if (userId) clearVaultKey(userId)
    navigate('/login')
  }

  // Preamble to per-peer revocation: rotates K_vault to a fresh epoch (fresh
  // K_doc per known channel too), delivered live to whoever's connected right
  // now — see EdgesyncVaultSession.renewVaultKey(). Works identically for S2
  // (Managed, re-escrowed in clear) and S3 (self-managed, re-escrowed wrapped
  // under K_User) — this button never knows which, same as everything else
  // downstream of KeyringSource.
  async function handleRenewVaultKey() {
    const vault = edgesyncVaultRef.current
    if (!vault) return
    try {
      await vault.renewVaultKey()
      notify('success', 'Clé du vault renouvelée', 'Nouvelle clé générée et propagée aux pairs connectés.')
    } catch (err) {
      console.error('[AppShell] renewVaultKey failed', err)
      notify('danger', 'Échec du renouvellement', err instanceof Error ? err.message : String(err))
    }
  }

  // Called once VaultKeyGate has actually set a key (never on cancel/backdrop
  // click — those clear keyModalRequest directly). Resumes whatever the
  // modal interrupted so the user never has to reload the page or manually
  // re-click to see the effect of the key they just entered — if it's still
  // wrong, switchToVault's own WrongVaultKeyError handling takes over again
  // exactly as if this were a fresh click.
  function handleKeyModalDone() {
    const req = keyModalRequest
    setKeyModalRequest(null)
    if (!req || !token) return
    if (req.kind === 'open-vault') void switchToVault(req.vault, token)
    else if (req.kind === 'create-vault') void onCreateVaultRef.current(req.name)
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
  // No gate here any more: the vault list belongs to the account, not to
  // whether a K_User is currently in memory — it always renders. Only
  // opening a specific vault depends on the key (per-row lock badge,
  // VaultBrowserWidget.tsx), surfaced via the key modal below instead of a
  // full-page takeover — see plan Context for why.

  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg-base)', color: 'var(--text)', fontFamily: 'var(--font-ui)' }}>

      {/* ── Icon rail ── */}
      <IconRail
        ribbonItems={ribbonItems}
        activeViewId={activeViewId}
        onRibbonClick={(item) => {
          const m = managerRef.current
          if (!m) return
          if (item.type === 'group') m.toggleGroup(item.id)
          else m.toggleView(item.id)
        }}
        onQuickOpen={() => setQuickOpenVisible(true)}
        onSettingsClick={() => setSettingsOpen(true)}
        activeAccount={activeAccount}
        accounts={accounts}
        onSwitchAccount={(acc) => void handleSwitchAccount(acc)}
        onAdmin={() => void navigate('/admin')}
        onManageKey={() => setKeyModalRequest({ kind: 'manage' })}
        onLogout={() => void handleLogout()}
      />

      {/* ── Main area (topbar + workspace stacked) ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>

      {/* ── Breadcrumb bar ── */}
      <div style={{ height: 42, background: 'var(--bg-surface)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 6, flexShrink: 0 }}>

        {/* Vault / fichier */}
        <span style={{ fontSize: 12.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
          {selectedVault?.name ?? '—'}
        </span>
        {activeDoc && <>
          <span style={{ color: 'var(--border)', fontSize: 14 }}>/</span>
          <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {activeDoc.path}
          </span>
        </>}
        {!activeDoc && <span style={{ flex: 1 }} />}

        {/* Right actions */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0, alignItems: 'center' }}>

          {activeDoc && (
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('app', 'topbar.saved')}</span>
          )}

          {/* Share */}
          {selectedVault && (
            <button onClick={() => setSharingOpen(true)} title={t('app', 'topbar.share')} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
                <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
              </svg>
              <span>{t('app', 'topbar.share')}</span>
            </button>
          )}

          {/* Renew vault key — preamble to revocation, see handleRenewVaultKey */}
          {selectedVault && (
            <button onClick={() => void handleRenewVaultKey()} title="Renouveler la clé du vault (rotation d'epoch, propagée aux pairs connectés)" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              <span>Renouveler la clé</span>
            </button>
          )}

          {/* Debug: show the vault's/active document's decrypted key — see VaultKeyDebugPanel */}
          {selectedVault && edgesyncVaultRef.current && (
            <button onClick={() => setKeyDebugOpen(true)} title="Afficher les clés en clair (debug)" style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', fontSize: 12, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
              </svg>
              <span>Clés (debug)</span>
            </button>
          )}

          {/* Editor mode toggle */}
          <button onClick={() => setMarkdownEditorMode(m => (m === 'source' ? 'rich' : 'source'))} title={t('app', 'topbar.editor.toggle')} style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', fontSize: 11, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-ui)' }}>
            {markdownEditorMode === 'source' ? t('app', 'topbar.editor.source') : t('app', 'topbar.editor.rich')}
          </button>

          {/* Language switcher */}
          <button
            onClick={() => setLocale(locale === 'fr' ? 'en' : 'fr')}
            title={locale === 'fr' ? 'Switch to English' : 'Passer en français'}
            style={{ padding: '3px 7px', borderRadius: 5, border: '1px solid var(--border)', background: 'transparent', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'var(--font-ui)', letterSpacing: '0.03em' }}
          >
            {locale === 'fr' ? 'EN' : 'FR'}
          </button>
        </div>
      </div>

      {/* ── Workspace — always rendered, never remounts ── */}
      <WorkspaceRoot
        vault={vaultProxy}
        fileTypesRef={fileTypeRegistryRef}
        onBeforeReady={onBeforeReady}
        onReady={(m) => {
          managerRef.current = m
          m.notifyVaultChange()
          setRibbonItems(m.getRibbonItems())
          m.subscribeActiveView(setActiveViewId)
          m.openDefaultLeft('explorer')
        }}
        style={{ flex: 1, overflow: 'hidden' }}
      />

      {/* ── Settings modal ── */}
      {settingsOpen && (
        <div onClick={() => setSettingsOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.24)', width: 560, maxWidth: '90vw', maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <SettingsPanel loader={pluginLoaderRef.current} triggers={triggersRef.current ?? { register: () => {}, unregister: () => {}, getAll: () => [], findConflict: () => undefined }} />
            <button onClick={() => setSettingsOpen(false)} style={{ position: 'absolute', top: 12, right: 14, background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer', zIndex: 1 }}>✕</button>
          </div>
        </div>
      )}

      {/* ── Key modal — reachable any time via the avatar menu, or by clicking
          a locked vault; VaultKeyGate supplies its own full card styling
          (width/border/shadow), this wrapper only owns the dimmed backdrop
          and the ✕ anchor, or the card would end up double-boxed. ── */}
      {keyModalRequest && activeAccount && (
        <div onClick={() => setKeyModalRequest(null)} style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ position: 'relative' }}>
            <VaultKeyGate userId={activeAccount.userId} onDone={handleKeyModalDone} />
            <button onClick={() => setKeyModalRequest(null)} style={{ position: 'absolute', top: 12, right: 14, background: 'none', border: 'none', color: 'var(--text-faint)', fontSize: '1.1rem', cursor: 'pointer', zIndex: 1 }}>✕</button>
          </div>
        </div>
      )}

      {sharingOpen && token && selectedVault && (
        <SharingPanel
          token={token}
          vault={selectedVault}
          document={activeDoc}
          sharingApi={application.sharing}
          onClose={() => setSharingOpen(false)}
        />
      )}

      {keyDebugOpen && selectedVault && edgesyncVaultRef.current && (
        <VaultKeyDebugPanel
          vaultName={selectedVault.name}
          edgesyncVault={edgesyncVaultRef.current}
          activeDoc={activeDoc ? { id: activeDoc.id, path: activeDoc.path } : null}
          onClose={() => setKeyDebugOpen(false)}
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
    </div>
  )
}
