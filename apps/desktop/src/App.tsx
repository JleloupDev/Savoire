// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useRef, useMemo, useCallback, useEffect } from 'react'
import { Editor } from '@savoire/editor-react'
import type { EditorProps } from '@savoire/editor-react'
import { DocumentStore, VaultClient } from '@savoire/platform'
import type { IDocumentMeta } from '@savoire/platform'
import { desktopDocumentFetcher, desktopVaultStorage, listMarkdownDocs } from './platform/adapters'
import './app.css'

// ── Tauri detection ───────────────────────────────────────────────────────────
const isTauri = '__TAURI__' in window

// ── Theme ─────────────────────────────────────────────────────────────────────
const THEMES = [
  { value: 'light',           label: '☀  Light' },
  { value: 'dark',            label: '🌙 Dark' },
  { value: 'solarized-light', label: '☀  Solarized Light' },
  { value: 'solarized-dark',  label: '🌙 Solarized Dark' },
]

const S = {
  sectionLabel: {
    fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-faint)',
    textTransform: 'uppercase' as const, letterSpacing: '0.08em',
  },
  btn: {
    padding: '4px 10px', background: 'var(--bg-elevated)', color: 'var(--text-muted)',
    border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: '0.75rem',
  } as React.CSSProperties,
}

// ── App ───────────────────────────────────────────────────────────────────────

export function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null)
  const [docs, setDocs] = useState<IDocumentMeta[]>([])
  const [activeDoc, setActiveDoc] = useState<IDocumentMeta | null>(null)
  const [initialContent, setInitialContent] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [connStatus, setConnStatus] = useState('...')
  const [theme, setTheme] = useState(() => localStorage.getItem('poc-theme-desktop') ?? 'light')
  const [showTheme, setShowTheme] = useState(false)

  const controllerRef = useRef<Parameters<NonNullable<import('@savoire/editor-react').EditorProps['onReady']>>[0]>(null)
  const documentStore = useRef(new DocumentStore(desktopDocumentFetcher))
  const docsRef = useRef(docs)
  docsRef.current = docs

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('poc-theme-desktop', theme)
  }, [theme])

  useEffect(() => {
    const id = setInterval(() => {
      if (controllerRef.current) setConnStatus(controllerRef.current.getConnectionStatus())
    }, 1500)
    return () => clearInterval(id)
  }, [])

  // ── Vault ──────────────────────────────────────────────────────────────────

  async function openVault() {
    const { open } = await import('@tauri-apps/api/dialog')
    const selected = await open({ directory: true, multiple: false, title: 'Ouvrir un vault' })
    if (!selected || Array.isArray(selected)) return
    setVaultPath(selected)
    setActiveDoc(null)
    setInitialContent(undefined)
    setDocs(await listMarkdownDocs(selected))
  }

  // ── Documents ──────────────────────────────────────────────────────────────

  const openDoc = useCallback(async (doc: IDocumentMeta) => {
    if (!vaultPath) return
    if (activeDoc) documentStore.current.close(vaultPath, activeDoc.id)
    const opened = await documentStore.current.open(vaultPath, doc.id, doc, '')
    setInitialContent(opened.content)
    setActiveDoc(doc)
  }, [vaultPath, activeDoc])

  async function createDoc() {
    if (!vaultPath) return
    const name = window.prompt('Chemin du fichier (ex: note.md ou Inbox/note.md)')
    if (!name?.trim()) return
    const path = name.trim().endsWith('.md') ? name.trim() : name.trim() + '.md'
    const { writeTextFile, createDir } = await import('@tauri-apps/api/fs')
    const { join, dirname } = await import('@tauri-apps/api/path')
    const full = await join(vaultPath, path)
    await createDir(await dirname(full), { recursive: true })
    await writeTextFile(full, '')
    const newDoc: IDocumentMeta = { id: path, path }
    const updated = [...docs, newDoc].sort((a, b) => a.path.localeCompare(b.path))
    setDocs(updated)
    await openDoc(newDoc)
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async function saveDoc() {
    if (!vaultPath || !activeDoc) return
    setSaving(true)
    try {
      const content = controllerRef.current?.exportMarkdown() ?? ''
      const { writeTextFile } = await import('@tauri-apps/api/fs')
      const { join } = await import('@tauri-apps/api/path')
      await writeTextFile(await join(vaultPath, activeDoc.path), content)
    } finally {
      setSaving(false)
    }
  }

  // ── Keyboard shortcut Ctrl/Cmd+S ──────────────────────────────────────────

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        void saveDoc()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ── VaultClient (platform) ────────────────────────────────────────────────

  const vaultAPI = useMemo((): EditorProps['vault'] => {
    if (!vaultPath) return undefined

    const client = new VaultClient(
      vaultPath,
      '',
      desktopVaultStorage,
      documentStore.current,
      (p) => docsRef.current.find(d => d.path === p || d.path === p + '.md'),
    )

    const resolveDocId = (path: string): string | undefined =>
      docsRef.current.find(d => d.path === path || d.path === `${path}.md`)?.id

    return {
      read: (documentId) => client.read(documentId),
      readDocumentByPath: (path) => client.readDocumentByPath(path),
      write: (documentId, content) => {
        return client.write(documentId, content)
      },
      list: (dir) => client.list(dir),
      exists: (documentId) => client.exists(documentId),
      resolveDocumentId: (path) => resolveDocId(path),
      createFile: (path) => client.createFile(path),
      createFolder: (path) => client.createFolder(path),
      renameFile: (documentId, newPath) => client.renameFile(documentId, newPath),
      deleteFile: (documentId) => client.deleteFile(documentId),
      deleteFolder: (path) => client.deleteFolder(path),
    }
  }, [vaultPath])

  // ── Not in Tauri ──────────────────────────────────────────────────────────

  if (!isTauri) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 14 }}>
        <span style={{ fontSize: 40 }}>🖥</span>
        <p style={{ color: 'var(--text-muted)', margin: 0 }}>Le filesystem local nécessite Tauri.</p>
        <code style={{ background: 'var(--bg-elevated)', padding: '6px 14px', borderRadius: 'var(--radius)', color: 'var(--color-code)', fontSize: '0.82rem' }}>
          pnpm --filter @savoire/desktop tauri:dev
        </code>
        <p style={{ color: 'var(--text-faint)', fontSize: '0.78rem', margin: 0 }}>Prérequis : Rust + cargo installés</p>
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const vaultName = vaultPath ? vaultPath.split(/[\\/]/).pop() ?? vaultPath : null

  return (
    <div style={{ display: 'flex', height: '100vh', flexDirection: 'column', background: 'var(--bg-base)', color: 'var(--text)' }}>

      {/* Topbar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)', minHeight: 40, flexShrink: 0 }}>
        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: activeDoc ? 'var(--text)' : 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}>
          {activeDoc ? `${vaultName} / ${activeDoc.path}` : '— Ouvrir un vault —'}
        </span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
          {activeDoc && (
            <>
              <span style={{ fontSize: 11, color: connStatus === 'connected' ? 'var(--color-success)' : 'var(--text-faint)' }}>
                {connStatus}
              </span>
              <button onClick={saveDoc} disabled={saving} style={S.btn}>
                {saving ? '…' : '↓ Enregistrer'}
              </button>
            </>
          )}
          {/* Theme picker */}
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowTheme(v => !v)} style={S.btn}>⚙ Thème</button>
            {showTheme && (
              <div style={{ position: 'absolute', top: 30, right: 0, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 4, zIndex: 99, minWidth: 160, boxShadow: 'var(--shadow)', display: 'flex', flexDirection: 'column' }}>
                {THEMES.map(t => (
                  <button key={t.value} onClick={() => { setTheme(t.value); setShowTheme(false) }}
                    style={{ textAlign: 'left', padding: '5px 10px', border: 'none', background: t.value === theme ? 'var(--bg-elevated)' : 'transparent', color: 'var(--text)', fontSize: '0.8rem', borderRadius: 4 }}>
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* Sidebar */}
        <div style={{ width: 210, minWidth: 210, borderRight: '1px solid var(--border)', background: 'var(--bg-base)', display: 'flex', flexDirection: 'column', padding: '10px 8px', gap: 6, overflow: 'hidden' }}>
          <div style={S.sectionLabel}>Vault</div>
          <button onClick={openVault} style={{ ...S.btn, textAlign: 'left', padding: '5px 8px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {vaultName ? `📂 ${vaultName}` : '+ Ouvrir un dossier…'}
          </button>

          {vaultPath && (
            <>
              <div style={{ ...S.sectionLabel, paddingTop: 8, borderTop: '1px solid var(--border)' }}>Fichiers</div>
              <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
                {docs.length === 0 && (
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-faint)', padding: '4px 8px' }}>Aucun fichier .md</div>
                )}
                {docs.map(doc => (
                  <button key={doc.id} onClick={() => openDoc(doc)} style={{
                    textAlign: 'left', padding: '4px 8px', border: 'none', borderRadius: 'var(--radius)',
                    background: doc.id === activeDoc?.id ? 'var(--bg-elevated)' : 'transparent',
                    color: doc.id === activeDoc?.id ? 'var(--text)' : 'var(--text-muted)',
                    fontSize: '0.8rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {doc.path}
                  </button>
                ))}
              </div>
              <button onClick={createDoc} style={{ ...S.btn, color: 'var(--color-success)', marginTop: 4 }}>+ Nouveau fichier</button>
            </>
          )}
        </div>

        {/* Editor */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {activeDoc && vaultPath ? (
            <Editor
              key={`${vaultPath}/${activeDoc.id}`}
              serverUrl=""
              vaultId={vaultPath}
              docId={activeDoc.id}
              userId="desktop"
              initialContent={initialContent}
              vault={vaultAPI}
              style={{ height: '100%' }}
              onReady={ctrl => {
                controllerRef.current = ctrl
                setConnStatus(ctrl?.getConnectionStatus() ?? '...')
              }}
            />
          ) : (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-faint)', fontSize: '0.9rem' }}>
              {vaultPath ? 'Cliquez sur un fichier pour l\'ouvrir.' : 'Ouvrez un dossier dans la sidebar.'}
            </div>
          )}
        </div>
      </div>

      {showTheme && <div onClick={() => setShowTheme(false)} style={{ position: 'fixed', inset: 0, zIndex: 98 }} />}
    </div>
  )
}
