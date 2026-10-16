// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { useCallback, useEffect, useState, useRef } from 'react'
import type { ViewContext, VaultAPI, FileTypeSpec } from '@savoire/plugin-api'
import { extensionOf, groupEntries, isInside, lastSegment, parentOf, stemOf, type TreeNode } from './folderNotes'
import { collectFolder, createDocument, createSubPage, deleteFolderDeep, moveFolder, moveNote } from './folderOps'
import { ConfirmDialog, TrashSection, type DialogChoice, type DialogRequest } from './TrashPanel'
import { trashFolderRequest, trashSubPagesRequest } from './trashMessages'

// ─── FileTree component ───────────────────────────────────────────────────

interface FileTreeProps {
  vault: VaultAPI
  onOpenFile: (path: string) => void
  workspace: ViewContext['workspace']
  fileTypes: FileTypeSpec[]
  /** Relit les types a chaque rendu (plugins actives ou desactives). */
  readFileTypes?: () => FileTypeSpec[]
}

type FileNode = TreeNode

function isDerivedDoc(path: string): boolean {
  return path.endsWith('.derived.md')
}

function displayName(name: string, fileTypes: FileTypeSpec[]): string {
  const spec = fileTypes.find(s => name === s.extension || name.endsWith('.' + s.extension))
  return spec ? name.slice(0, -(spec.extension.length + 1)) : name
}

/** Dossier dont la ligne montre les enfants : le dossier, ou celui de la note. */
function folderPathOf(node: FileNode): string | undefined {
  if (node.kind === 'folder') return node.path
  if (node.kind === 'folderNote') return node.folderPath
  return undefined
}

/** Nom de fichier de la ligne (extension comprise), ou undefined pour un dossier. */
function fileNameOf(node: FileNode): string | undefined {
  if (node.kind === 'file') return node.name
  if (node.kind === 'folderNote') return node.fileName
  return undefined
}

async function buildTree(vault: VaultAPI, dir: string): Promise<FileNode[]> {
  const entries = await vault.list(dir)
  return groupEntries(entries.filter(entry => !isDerivedDoc(entry)))
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
  fileTypes,
  ask,
}: {
  node: FileNode
  onOpenFile: (p: string) => void
  depth: number
  vault: VaultAPI
  onDeleted: () => void
  onRenamed: () => void
  draggedRef: React.MutableRefObject<FileNode | null>
  onCreateInside?: (type: 'file' | 'folder', folderPath: string) => void
  fileTypes: FileTypeSpec[]
  /** Fenetre de confirmation de l'explorateur. */
  ask: (request: DialogRequest) => Promise<DialogChoice>
}) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FileNode[]>([])
  const [childTick, setChildTick] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const editInputRef = useRef<HTMLInputElement>(null)
  const indent = depth * 12
  const folderPath = folderPathOf(node)
  const fileName = fileNameOf(node)
  const isPlainFolder = node.kind === 'folder'

  useEffect(() => {
    if (!expanded || !folderPath) return
    buildTree(vault, folderPath).then(setChildren).catch(() => setChildren([]))
  }, [expanded, node, folderPath, vault, childTick])

  useEffect(() => {
    if (isEditing) {
      editInputRef.current?.focus()
      editInputRef.current?.select()
    }
  }, [isEditing])

  // Un dossier se deplie au clic ; un fichier ou une note de dossier s'ouvre.
  const handleClick = () => {
    if (isPlainFolder) setExpanded(prev => !prev)
    else onOpenFile(node.path)
  }

  // Supprimer = mettre a la corbeille (VaultAPI.deleteFile) : rien n'est
  // efface, tout se restaure depuis la corbeille en bas de l'explorateur.
  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      if (node.kind === 'folder') {
        // Un dossier part avec ses documents : on dit combien.
        const { files } = await collectFolder(vault, node.path)
        const choice = await ask(trashFolderRequest(node.name, files.length))
        if (choice !== 'confirm') return
        await deleteFolderDeep(vault, node.path)
      } else {
        // Note de dossier : on demande pour les sous-pages. « Garder » laisse
        // le dossier, qui redevient un dossier simple.
        if (node.kind === 'folderNote') {
          const { files } = await collectFolder(vault, node.folderPath)
          if (files.length > 0) {
            const choice = await ask(trashSubPagesRequest(node.name, files.length))
            if (choice === 'cancel') return
            if (choice === 'confirm') await deleteFolderDeep(vault, node.folderPath)
          }
        }
        const docId = vault.resolveDocumentId(node.path)
        if (!docId) throw new Error(`Document not found: ${node.path}`)
        await vault.deleteFile?.(docId)
      }
      onDeleted()
    } catch (err) { alert(String(err)) }
  }

  /** Renomme la ligne vers un nouveau chemin (fichier) ou un nouveau dossier. */
  async function renameTo(target: string) {
    if (node.kind === 'folder') {
      const to = target.endsWith('/') ? target : target + '/'
      if (to === node.path) return
      await moveFolder(vault, node.path, to)
      return
    }
    // Sans extension, on garde celle du fichier (une page reste une page).
    const normalized = lastSegment(target).includes('.') ? target : `${target}.${extensionOf(node.path) || 'md'}`
    if (normalized === node.path) return
    // Fichier ou note de dossier : le dossier frere suit s'il existe.
    await moveNote(vault, node.path, normalized)
  }

  async function handleRename(e: React.MouseEvent) {
    e.stopPropagation()
    if (!vault.renameFile) return
    const label = isPlainFolder ? 'Nouveau chemin du dossier' : 'Nouveau chemin du document'
    const next = prompt(label, node.path)
    const trimmed = next?.trim()
    if (!trimmed || trimmed === node.path) return
    try {
      await renameTo(trimmed)
      onRenamed()
    } catch (err) { alert(String(err)) }
  }

  async function handleRenameInline(newName: string) {
    const trimmed = newName.trim()
    setIsEditing(false)
    const current = fileName ?? node.name
    if (!trimmed || trimmed === current || !vault.renameFile) return
    try {
      await renameTo(parentOf(node.path) + trimmed)
      onRenamed()
    } catch (err) { alert(String(err)) }
  }

  async function handleNewSubPage(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      const path = await createSubPage(vault, node.path, fileTypes)
      setExpanded(true)
      setChildTick(t => t + 1)
      onRenamed()
      onOpenFile(path)
    } catch (err) { alert(String(err)) }
  }

  // ── Drag & drop ──────────────────────────────────────────────────────────

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setIsDragOver(false)
    const dragged = draggedRef.current
    draggedRef.current = null
    if (!dragged || !folderPath || dragged.kind === 'folder' || !vault.renameFile) return
    // Ne pas deplacer dans le meme dossier, ni une note dans son propre dossier.
    if (parentOf(dragged.path) === folderPath) return
    if (dragged.path === node.path) return
    if (dragged.kind === 'folderNote' && (folderPath === dragged.folderPath || isInside(folderPath, dragged.folderPath))) return
    const draggedFileName = fileNameOf(dragged)!
    try {
      // Une note de dossier emmene son dossier.
      await moveNote(vault, dragged.path, folderPath + draggedFileName)
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

  const fileIcon = fileName ? (fileTypes.find(s => fileName.endsWith('.' + s.extension))?.icon ?? '·') : ''
  const hoverBtn: React.CSSProperties = {
    opacity: 0, background: 'none', border: 'none', color: 'var(--text-muted, #ccc)',
    cursor: 'pointer', fontSize: 10, padding: '0 3px', flexShrink: 0,
    transition: 'opacity 0.1s',
  }

  return (
    <div>
      <div
        data-testid={isPlainFolder ? 'tree-folder' : 'tree-file'}
        data-path={node.path}
        data-name={node.name}
        data-folder={folderPath}
        data-folder-note={node.kind === 'folderNote' ? 'true' : undefined}
        style={rowStyle}
        draggable={!isPlainFolder}
        onDragStart={e => {
          draggedRef.current = node
          // Also broadcast for dockview layout drop (drag to split editor)
          if (!isPlainFolder) {
            e.dataTransfer.setData('text/x-poc-file-path', node.path)
            e.dataTransfer.effectAllowed = 'link'
          }
        }}
        onDragEnd={() => { draggedRef.current = null }}
        onDragOver={folderPath ? (e) => { e.preventDefault(); setIsDragOver(true) } : undefined}
        onDragLeave={folderPath ? () => setIsDragOver(false) : undefined}
        onDrop={folderPath ? (e) => void handleDrop(e) : undefined}
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
          {node.kind === 'folderNote' && (
            // Chevron a part : il deplie sans ouvrir la note.
            <span
              data-testid="tree-toggle"
              onClick={e => { e.stopPropagation(); setExpanded(prev => !prev) }}
              style={{ width: 10, flexShrink: 0 }}
              title={expanded ? 'Replier' : 'Deplier'}
            >{expanded ? '▾' : '▸'}</span>
          )}
          {isPlainFolder ? (expanded ? '▾' : '▸') : fileIcon}
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
                if (!vault.renameFile) return
                e.stopPropagation()
                setEditValue(fileName ?? node.name)
                setIsEditing(true)
              }}
            >
              {node.kind === 'folderNote' ? node.name : displayName(node.name, fileTypes)}
            </span>
          )}
        </span>
        {isPlainFolder && onCreateInside && (
          <>
            <button
              className="add-btn"
              onClick={e => { e.stopPropagation(); onCreateInside('file', node.path) }}
              style={hoverBtn}
              title="Nouvelle note dans ce dossier"
            >+note</button>
            <button
              className="add-btn"
              onClick={e => { e.stopPropagation(); onCreateInside('folder', node.path) }}
              style={hoverBtn}
              title="Nouveau dossier dans ce dossier"
            >+dir</button>
          </>
        )}
        {!isPlainFolder && vault.createFile && stemOf(node.path) && (
          <button
            className="add-btn"
            data-testid="tree-new-subpage"
            onClick={e => void handleNewSubPage(e)}
            style={hoverBtn}
            title="Nouvelle sous-page"
          >+sous</button>
        )}
        {(vault.deleteFile ?? vault.deleteFolder) && (
          <button
            className="del-btn"
            data-testid="tree-delete"
            onClick={handleDelete}
            style={{
              opacity: 0, background: 'none', border: 'none', color: 'var(--color-danger, #f66)',
              cursor: 'pointer', fontSize: 11, padding: '0 4px', flexShrink: 0,
              transition: 'opacity 0.1s',
            }}
            title="Mettre a la corbeille"
          >✕</button>
        )}
        {vault.renameFile && (
          <button
            className="ren-btn"
            data-testid="tree-rename"
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
      {folderPath && expanded && (
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
            fileTypes={fileTypes}
            ask={ask}
          />
        ))
      )}
    </div>
  )
}

// ─── FileTree ──────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif'])

export function FileTree({ vault, onOpenFile, workspace, fileTypes: initialFileTypes, readFileTypes }: FileTreeProps) {
  // Relu a chaque rendu : un plugin active ou desactive change les types
  // disponibles (icones, choix a la creation). Le rendu suit la notification
  // de changement du workspace.
  const fileTypes = readFileTypes?.() ?? initialFileTypes
  const [nodes, setNodes] = useState<FileNode[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [isDropTarget, setIsDropTarget] = useState(false)

  // ── Create form state ────────────────────────────────────────────────────
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null)
  const [newPath, setNewPath] = useState('')
  const [selectedExtension, setSelectedExtension] = useState<string>('md')
  const inputRef = useRef<HTMLInputElement>(null)

  // ── Drag state (shared across all rows) ─────────────────────────────────
  const draggedRef = useRef<FileNode | null>(null)

  // ── Fenetre de confirmation (une a la fois) ──────────────────────────────
  const [dialog, setDialog] = useState<{ request: DialogRequest; resolve: (c: DialogChoice) => void } | null>(null)
  const ask = useCallback((request: DialogRequest) => new Promise<DialogChoice>(resolve => {
    setDialog({ request, resolve })
  }), [])
  const choose = useCallback((choice: DialogChoice) => {
    setDialog(current => { current?.resolve(choice); return null })
  }, [])

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
        const normalized = p.includes('.') ? p : `${p}.${selectedExtension}`
        await createDocument(vault, normalized, fileTypes)
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
            fileTypes={fileTypes}
            ask={ask}
            onCreateInside={(type, folderPath) => {
              setCreating(type)
              setNewPath(folderPath)
              setTimeout(() => inputRef.current?.focus(), 50)
            }}
          />
        ))}
      </div>

      <TrashSection vault={vault} tick={tick} onChanged={() => setTick(t => t + 1)} ask={ask} />

      {dialog && <ConfirmDialog request={dialog.request} onChoose={choose} />}

      {/* Footer: create controls */}
      {(canCreateFile || canCreateFolder) && (
        <div style={{
          flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.08)',
          padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {creating ? (
            <>
              <input
                data-testid="tree-create-name"
                ref={inputRef}
                value={newPath}
                onChange={e => { setNewPath(e.target.value); if (error) setError('') }}
                onKeyDown={e => { if (e.key === 'Enter') void handleCreate(); if (e.key === 'Escape') cancelCreate() }}
                placeholder={creating === 'file' ? 'nom (extension auto)' : 'Inbox/ ou Inbox/Notes/'}
                style={{
                  padding: '4px 7px', background: 'rgba(255,255,255,0.07)',
                  color: 'inherit',
                  border: `1px solid ${error ? 'var(--color-danger, #dc2626)' : 'rgba(255,255,255,0.15)'}`,
                  borderRadius: 4, fontSize: 12, outline: 'none', width: '100%',
                  boxSizing: 'border-box',
                }}
              />
              {creating === 'file' && fileTypes.some(s => s.creatable !== false) && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {fileTypes.filter(s => s.creatable !== false).map(spec => (
                    <button
                      key={spec.extension}
                      onClick={() => setSelectedExtension(spec.extension)}
                      title={spec.label}
                      style={{
                        padding: '2px 6px', fontSize: 11, cursor: 'pointer', borderRadius: 3,
                        border: `1px solid ${selectedExtension === spec.extension ? 'var(--accent, #7c3aed)' : 'rgba(255,255,255,0.15)'}`,
                        background: selectedExtension === spec.extension ? 'rgba(124,58,237,0.2)' : 'rgba(255,255,255,0.04)',
                        color: 'inherit',
                      }}
                    >
                      {spec.icon} {spec.label}
                    </button>
                  ))}
                </div>
              )}
              {error && (
                <div style={{ fontSize: 11, color: 'var(--color-danger, #dc2626)', padding: '2px 2px 0' }}>
                  {error}
                </div>
              )}
              <div style={{ display: 'flex', gap: 4 }}>
                <button data-testid="tree-create-confirm" onClick={() => void handleCreate()} disabled={!newPath.trim()} style={btnStyle('#4caf50')}>OK</button>
                <button onClick={cancelCreate} style={btnStyle('#f66')}>Ann.</button>
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', gap: 4 }}>
              {canCreateFile && <button data-testid="tree-new-file" onClick={() => { setCreating('file'); setNewPath('') }} style={btnStyle('#4caf50')}>+ Note</button>}
              {canCreateFolder && <button data-testid="tree-new-folder" onClick={() => { setCreating('folder'); setNewPath('') }} style={btnStyle('var(--text-muted, #bbb)')}>+ Dossier</button>}
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
        fileTypes={this.ctx.fileTypes.getAll()}
        readFileTypes={() => this.ctx.fileTypes.getAll()}
        onOpenFile={(path) => void this.ctx.workspace.openFile(path)}
      />
    )
  }

  dispose(): void {
    // no cleanup needed
  }
}
