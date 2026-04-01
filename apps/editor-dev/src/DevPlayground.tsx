// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useState, useEffect } from 'react'
import { Editor, useEditor } from '@savoire/editor-react'
import { MockFileSelector } from './MockFileSelector'
import { MemoryVaultProvider } from './mock/MemoryVaultProvider'
import { FsVaultProvider } from './mock/FsVaultProvider'
import { ALL_MOCK_SETS } from './mock/mockFileSets'
import type { MockFileSet } from './mock/types'
import type { VaultAPI } from '@savoire/plugin-api'

const initialSet = ALL_MOCK_SETS[0]

function loadSet(set: MockFileSet): { content: string; vault: MemoryVaultProvider } {
  const vault = new MemoryVaultProvider(set.files)
  const entry = set.entry ?? Object.keys(set.files)[0]
  return { content: set.files[entry] ?? '', vault }
}

interface FolderSession {
  vault: FsVaultProvider
  files: string[]
  activeFile: string
}

export function DevPlayground() {
  const [activeSet, setActiveSet] = useState<MockFileSet>(initialSet)
  const [{ content, vault: mockVault }, setSession] = useState(() => loadSet(initialSet))
  const [folderSession, setFolderSession] = useState<FolderSession | null>(null)
  const { controller } = useEditor()

  const activeVault: VaultAPI = folderSession?.vault ?? mockVault

  async function openFolder() {
    if (!('showDirectoryPicker' in window)) {
      alert('File System Access API not supported in this browser. Use Chrome or Edge.')
      return
    }
    try {
      const fsVault = await FsVaultProvider.fromPicker()
      const files = await fsVault.list()
      const mdFiles = files.filter((f) => f.endsWith('.md'))
      if (mdFiles.length === 0) { alert('No .md files found in this folder.'); return }
      const first = mdFiles.find((f) => f === 'index.md') ?? mdFiles[0]
      setFolderSession({ vault: fsVault, files: mdFiles, activeFile: first })
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') console.error(err)
    }
  }

  function clearFolder() {
    setFolderSession(null)
  }

  function handleSelect(set: MockFileSet) {
    setActiveSet(set)
    setSession(loadSet(set))
    setFolderSession(null)
  }

  async function handleSave() {
    controller?.save()
  }

  const editorKey = folderSession
    ? `folder:${folderSession.vault.folderName}:${folderSession.activeFile}`
    : activeSet.id

  return (
    <div style={{ display: 'flex', height: '100vh', flexDirection: 'column' }}>
      <header
        style={{
          padding: '6px 12px',
          background: '#ffffff',
          borderBottom: '1px solid #dddcd5',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <strong style={{ color: '#1a1a18', fontSize: 13 }}>Editor Dev</strong>

        {!folderSession && (
          <MockFileSelector sets={ALL_MOCK_SETS} activeId={activeSet.id} onSelect={handleSelect} />
        )}

        {folderSession && (
          <span style={{ fontSize: 12, color: '#555', display: 'flex', alignItems: 'center', gap: 6 }}>
            📁 <strong>{folderSession.vault.folderName}</strong>
            <button
              onClick={clearFolder}
              style={{ fontSize: 11, padding: '1px 6px', background: '#f0efe9', border: '1px solid #dddcd5', borderRadius: 3, cursor: 'pointer' }}
            >
              ✕
            </button>
          </span>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <button
            onClick={openFolder}
            style={{ fontSize: 11, padding: '2px 8px', background: '#f0efe9', color: '#1a1a18', border: '1px solid #dddcd5', borderRadius: 4, cursor: 'pointer' }}
          >
            📁 Open Folder
          </button>
          <button
            onClick={() => controller?.executeCommand('toggle-bold')}
            style={{ fontSize: 11, padding: '2px 8px', background: '#f0efe9', color: '#1a1a18', border: '1px solid #dddcd5', borderRadius: 4, cursor: 'pointer' }}
          >
            Bold
          </button>
          <button
            onClick={handleSave}
            style={{ fontSize: 11, padding: '2px 8px', background: '#f0efe9', color: '#1a1a18', border: '1px solid #dddcd5', borderRadius: 4, cursor: 'pointer' }}
          >
            Save
          </button>
        </div>
      </header>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {folderSession && (
          <aside
            style={{
              width: 200,
              minWidth: 160,
              borderRight: '1px solid #dddcd5',
              background: '#f9f9f7',
              overflowY: 'auto',
              padding: '8px 0',
              flexShrink: 0,
            }}
          >
            {folderSession.files.map((path) => (
              <button
                key={path}
                onClick={() => setFolderSession((s) => s ? { ...s, activeFile: path } : s)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '4px 12px',
                  fontSize: 12,
                  border: 'none',
                  background: path === folderSession.activeFile ? '#e8e8e2' : 'transparent',
                  color: '#1a1a18',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                📄 {path}
              </button>
            ))}
          </aside>
        )}

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {folderSession ? (
            <FolderFileEditor
              key={editorKey}
              path={folderSession.activeFile}
              vault={folderSession.vault}
            />
          ) : (
            <Editor
              key={editorKey}
              docId={activeSet.id}
              initialContent={content}
              vault={activeVault}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// Loads file content then mounts the editor — separated so key-remount resets load state.
function FolderFileEditor({ path, vault }: { path: string; vault: FsVaultProvider }) {
  const [fileContent, setFileContent] = useState<string | null>(null)

  useEffect(() => {
    vault.readDocumentByPath(path).then(setFileContent).catch(() => setFileContent(''))
  }, [path, vault])

  if (fileContent === null) {
    return <div style={{ padding: 24, color: '#aaa', fontSize: 13 }}>Loading {path}…</div>
  }

  return <Editor docId={path} initialContent={fileContent} vault={vault} />
}
