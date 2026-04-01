// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useEffect, useState, useRef } from 'react'
import type { ViewContext, VaultAPI } from '@savoire/plugin-api'

// ─── FileTree component ───────────────────────────────────────────────────

interface FileTreeProps {
  vault: VaultAPI
  onOpenFile: (path: string) => void
  workspace: ViewContext['workspace']
}

interface FileNode {
  name: string
  path: string
  isDir: boolean
}

function isDerivedDoc(path: string): boolean {
  return path.endsWith('.derived.md')
}

async function buildTree(vault: VaultAPI, dir: string): Promise<FileNode[]> {
  const entries = await vault.list(dir)
  return entries
    .filter(entry => !isDerivedDoc(entry))
    .map(entry => {
      const isDir = entry.endsWith('/')
      const name = isDir
        ? (entry.slice(0, -1).split('/').at(-1) ?? entry)
        : (entry.split('/').at(-1) ?? entry)
      return { name, path: entry, isDir }
    })
}

// ─── Row ─────────────────────────────────────────────────────────────────

function FileNodeRow({
  node,
  onOpenFile,
  depth,
  vault,
  onDeleted,
  onRenamed,
  draggedRef,
  onCreateInside,
}: {
  node: FileNode
  onOpenFile: (p: string) => void
  depth: number
  vault: VaultAPI
  onDeleted: () => void
  onRenamed: () => void
  draggedRef: React.MutableRefObject<FileNode | null>
  onCreateInside?: (type: 'file' | 'folder', folderPath: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileNode[]>([])
  const [childTick, setChildTick] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const indent = depth * 12

  useEffect(() => {
    if (!expanded || !node.isDir) return
    buildTree(vault, node.path).then(setChildren).catch(() => setChildren([]))
  }, [expanded, node, vault, childTick])

  useEffect(() => {
    if (isEditing) {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }
  }, [isEditing])

  const handleClick = () => {
    if (node.isDir) setExpanded(prev => !prev)
    else onOpenFile(node.path)
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`Supprimer "${node.name}" ?`)) return
    try {
      if (node.isDir) await vault.deleteFolder?.(node.path)
      else {
        const docId = vault.resolveDocumentId(node.path)
        if (!docId) throw new Error(`Document not found: ${node.path}`)
        await vault.deleteFile?.(docId)
      }
      onDeleted()
    } catch (err) { alert(String(err)) }
  }

  async function handleRename(e: React.MouseEvent) {
    e.stopPropagation()
    if (node.isDir || !vault.renameFile) return
    const next = prompt('Nouveau chemin du document', node.path)
    const trimmed = next?.trim()
    if (!trimmed || trimmed === node.path) return
    try {
      const docId = vault.resolveDocumentId(node.path)
      if (!docId) throw new Error(`Document not found: ${node.path}`)
      const renamedPath = trimmed.includes('.') ? trimmed : `${trimmed}.md`
      await vault.renameFile(docId, renamedPath)
      onRenamed()
    } catch (err) { alert(String(err)) }
  }

  async function handleRenameInline(newName: string) {
    const trimmed = newName.trim()
    setIsEditing(false)
    if (!trimmed || trimmed === node.name || node.isDir || !vault.renameFile) return
    const dir = node.path.includes('/')
      ? node.path.slice(0, node.path.lastIndexOf('/') + 1)
      : ''
    const normalized = trimmed.includes('.') ? trimmed : `${trimmed}.md`
    const newPath = dir + normalized
    if (newPath === node.path) return
    try {
      const docId = vault.resolveDocumentId(node.path)
      if (!docId) throw new Error(`Document not found: ${node.path}`)
      await vault.renameFile(docId, newPath)
      onRenamed()
    } catch (err) { alert(String(err)) }
  }

  // ── Drag & drop ──────────────────────────────────────────────────────────

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const dragged = draggedRef.current
    draggedRef.current = null
    if (!dragged || dragged.isDir || !vault.renameFile) return
    // Ne pas déplacer dans le même dossier
    const currentFolder = dragged.path.includes('/')
      ? dragged.path.slice(0, dragged.path.lastIndexOf('/') + 1)
      : ''
    if (currentFolder === node.path) return
    const docId = vault.resolveDocumentId(dragged.path)
    if (!docId) return
    const newPath = node.path + dragged.name
    try {
      await vault.renameFile(docId, newPath)
      onRenamed()
    } catch (err) { alert(String(err)) }
  }

  const rowStyle: React.CSSProperties = {
    paddingLeft: indent + 8, paddingRight: 4, paddingTop: 3, paddingBottom: 3,
    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
    fontSize: 13, userSelect: 'none',
    outline: isDragOver ? '1px solid var(--accent, #7c3aed)' : 'none',
    outlineOffset: '-1px',
    borderRadius: 3,
  }

  return (
    <div>
      <div
        style={rowStyle}
        draggable={!node.isDir}
        onDragStart={e => {
          draggedRef.current = node
          // Also broadcast for dockview layout drop (drag to split editor)
          if (!node.isDir) {
            e.dataTransfer.setData('text/x-poc-file-path', node.path)
            e.dataTransfer.effectAllowed = 'link'
          }
        }}
        onDragEnd={() => { draggedRef.current = null }}
        onDragOver={node.isDir ? (e) => { e.preventDefault(); setIsDragOver(true) } : undefined}
        onDragLeave={node.isDir ? () => setIsDragOver(false) : undefined}
        onDrop={node.isDir ? (e) => void handleDrop(e) : undefined}
        onMouseEnter={e => {
          ;(e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.06)'
          const buttons = (e.currentTarget as HTMLElement).querySelectorAll('.del-btn, .ren-btn, .add-btn')
          buttons.forEach((btn) => { (btn as HTMLElement).style.opacity = '1' })
        }}
        onMouseLeave={e => {
          ;(e.currentTarget as HTMLElement).style.background = 'transparent'
          const buttons = (e.currentTarget as HTMLElement).querySelectorAll('.del-btn, .ren-btn, .add-btn')
          buttons.forEach((btn) => { (btn as HTMLElement).style.opacity = '0' })
        }}
      >
        <span onClick={handleClick} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
          {node.isDir ? (expanded ? '▾' : '▸') : '·'}
          {isEditing ? (
            <input
              ref={editInputRef}
              value={editValue}
              onChange={e => setEditValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.stopPropagation(); void handleRenameInline(editValue) }
                if (e.key === 'Escape') { e.stopPropagation(); setIsEditing(false) }
              }}
              onBlur={() => void handleRenameInline(editValue)}
              onClick={e => e.stopPropagation()}
              style={{
                flex: 1, padding: '0 3px', background: 'var(--bg-elevated, rgba(255,255,255,0.1))',
                color: 'inherit', border: '1px solid var(--accent, #7c3aed)',
                borderRadius: 3, fontSize: 12, outline: 'none', minWidth: 0,
              }}
            />
          ) : (
            <span
              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              onDoubleClick={e => {
                if (node.isDir || !vault.renameFile) return
                e.stopPropagation()
                setEditValue(node.name)
                setIsEditing(true)
              }}
            >
              {node.name}
            </span>
          )}
        </span>
        {node.isDir && onCreateInside && (
          <>
            <button
              className="add-btn"
              onClick={e => { e.stopPropagation(); onCreateInside('file', node.path) }}
              style={{
                opacity: 0, background: 'none', border: 'none', color: 'var(--text-muted, #ccc)',
                cursor: 'pointer', fontSize: 10, padding: '0 3px', flexShrink: 0,
                transition: 'opacity 0.1s',
              }}
              title="Nouvelle note dans ce dossier"
            >+note</button>
            <button
              className="add-btn"
              onClick={e => { e.stopPropagation(); onCreateInside('folder', node.path) }}
              style={{
                opacity: 0, background: 'none', border: 'none', color: 'var(--text-muted, #ccc)',
                cursor: 'pointer', fontSize: 10, padding: '0 3px', flexShrink: 0,
                transition: 'opacity 0.1s',
              }}
              title="Nouveau dossier dans ce dossier"
            >+dir</button>
          </>
        )}
        {(vault.deleteFile ?? vault.deleteFolder) && (
          <button
            className="del-btn"
            onClick={handleDelete}
            style={{
              opacity: 0, background: 'none', border: 'none', color: 'var(--color-danger, #f66)',
              cursor: 'pointer', fontSize: 11, padding: '0 4px', flexShrink: 0,
              transition: 'opacity 0.1s',
            }}
            title="Supprimer"
          >✕</button>
        )}
        {!node.isDir && vault.renameFile && (
          <button
            className="ren-btn"
            onClick={handleRename}
            style={{
              opacity: 0, background: 'none', border: 'none', color: 'var(--text-muted, #ccc)',
              cursor: 'pointer', fontSize: 11, padding: '0 4px', flexShrink: 0,
              transition: 'opacity 0.1s',
            }}
            title="Renommer"
          >✎</button>
        )}
      </div>
      {node.isDir && expanded && (
        children.map(c => (
          <FileNodeRow
            key={c.path}
            node={c}
            onOpenFile={onOpenFile}
            depth={depth + 1}
            vault={vault}
            onDeleted={() => setChildTick(t => t + 1)}
            onRenamed={() => { setChildTick(t => t + 1); onRenamed() }}
            draggedRef={draggedRef}
            onCreateInside={onCreateInside}
          />
        ))
      )}
    </div>
  )
}

// ─── FileTree ──────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])

export function FileTree({ vault, onOpenFile, workspace }: FileTreeProps) {
  const [nodes, setNodes] = useState<FileNode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [isDropTarget, setIsDropTarget] = useState(false)

  // ── Create form state ────────────────────────────────────────────────────
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
  const [newPath, setNewPath] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // ── Drag state (shared across all rows) ─────────────────────────────────
  const draggedRef = useRef<FileNode | null>(null)

  useEffect(() => {
    const manager = workspace as unknown as { subscribeVaultChange?: (cb: () => void) => () => void }
    return manager.subscribeVaultChange?.(() => setTick(t => t + 1))
  }, [workspace])

  useEffect(() => {
    buildTree(vault, '').then(setNodes).catch((err: unknown) => setError(String(err)))
  }, [vault, tick])

  useEffect(() => {
    if (creating) inputRef.current?.focus()
  }, [creating])

  async function handleCreate() {
    const p = newPath.trim()
    if (!p) return
    try {
      if (creating === 'file') {
        const normalized = p.includes('.') ? p : p + '.md'
        await vault.createFile?.(normalized)
        setCreating(null); setNewPath(''); setTick(t => t + 1)
        onOpenFile(normalized)
      } else {
        await vault.createFolder?.(p)
        setCreating(null); setNewPath(''); setTick(t => t + 1)
      }
    } catch (err) {
      const msg = String(err)
      if (msg.includes('409') || msg.toLowerCase().includes('conflict') || msg.toLowerCase().includes('already exists')) {
        setError('Un fichier avec ce nom existe déjà.')
      } else {
        setError(msg)
      }
    }
  }

  function cancelCreate() { setCreating(null); setNewPath(''); setError('') }

  async function handleOsFileDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDropTarget(false)
    if (!vault.uploadAttachment) return
    const files = Array.from(e.dataTransfer.files).filter(f => {
      const ext = f.name.split('.').at(-1)?.toLowerCase() ?? ''
      return IMAGE_EXTS.has(ext)
    })
    for (const file of files) {
      try {
        await vault.uploadAttachment(file)
        setTick(t => t + 1)
      } catch (err) { setError(String(err)) }
    }
  }

  const canCreateFile = !!vault.createFile
  const canCreateFolder = !!vault.createFolder

  return (
    <div
      style={{ fontFamily: 'inherit', color: 'inherit', height: '100%', display: 'flex', flexDirection: 'column' }}
      onDragOver={vault.uploadAttachment ? e => { e.preventDefault(); setIsDropTarget(true) } : undefined}
      onDragLeave={vault.uploadAttachment ? () => setIsDropTarget(false) : undefined}
      onDrop={vault.uploadAttachment ? e => void handleOsFileDrop(e) : undefined}
    >

      {/* Tree */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, outline: isDropTarget ? '2px dashed var(--accent,#7c3aed)' : 'none', outlineOffset: '-2px' }}>
        {nodes.map(n => (
          <FileNodeRow
            key={n.path}
            node={n}
            onOpenFile={onOpenFile}
            depth={0}
            vault={vault}
            onDeleted={() => setTick(t => t + 1)}
            onRenamed={() => setTick(t => t + 1)}
            draggedRef={draggedRef}
            onCreateInside={(type, folderPath) => {
              setCreating(type)
              setNewPath(folderPath)
              setTimeout(() => inputRef.current?.focus(), 50)
            }}
          />
        ))}
      </div>

      {/* Footer: create controls */}
      {(canCreateFile || canCreateFolder) && (
        <div style={{
          flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {creating ? (
            <>
              <input
                ref={inputRef}
                value={newPath}
                onChange={e => { setNewPath(e.target.value); if (error) setError('') }}
                onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') cancelCreate() }}
                placeholder={creating === 'file' ? 'note.md ou Inbox/note (→ .md auto)' : 'Inbox/ ou Inbox/Notes/'}
                style={{
                  padding: '4px 7px', background: 'rgba(255,255,255,0.07)',
                  color: 'inherit',
                  border: `1px solid ${error ? 'var(--color-danger, #dc2626)' : 'rgba(255,255,255,0.15)'}`,
                  borderRadius: 4, fontSize: 12, outline: 'none', width: '100%',
                  boxSizing: 'border-box',
                }}
              />
              {error && (
                <div style={{ fontSize: 11, color: 'var(--color-danger, #dc2626)', padding: '2px 2px 0' }}>
                  {error}
                </div>
              )}
              <div style={{ display: 'flex', gap: 4 }}>
                <button onClick={() => void handleCreate()} disabled={!newPath.trim()} style={btnStyle('#4caf50')}>OK</button>
                <button onClick={cancelCreate} style={btnStyle('#f66')}>Ann.</button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 4 }}>
              {canCreateFile && <button onClick={() => { setCreating('file'); setNewPath('') }} style={btnStyle('#4caf50')}>+ Note</button>}
              {canCreateFolder && <button onClick={() => { setCreating('folder'); setNewPath('') }} style={btnStyle('var(--text-muted, #bbb)')}>+ Dossier</button>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function btnStyle(color: string): React.CSSProperties {
  return {
    flex: 1, padding: '3px 6px', background: 'rgba(255,255,255,0.05)',
    color, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, fontSize: 11, cursor: 'pointer',
  }
}

// ─── FileTreeWidget — implements Widget ──────────────────────────────────

export class FileTreeWidget {
  constructor(private readonly ctx: ViewContext) {}

  render() {
    return (
      <FileTree
        vault={this.ctx.vault}
        workspace={this.ctx.workspace}
        onOpenFile={(path) => void this.ctx.workspace.openFile(path)}
      />
    )
  }

  dispose(): void {
    // no cleanup needed
  }
}
