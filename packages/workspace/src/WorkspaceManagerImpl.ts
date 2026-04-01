// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { WorkspaceAPI, ViewDocument } from '@savoire/plugin-api'
import type { WorkspacePort, WorkspaceLayout } from './types'
import { ViewRegistryImpl } from './ViewRegistryImpl'

export interface ActiveEditorInfo {
  filePath: string | null
  /** 'workspace' = always-on workspace plugin (views/filetree/file-type handlers).
   *  'default' = manifest.defaultActive. 'extension' = file ext.
   *  'frontmatter' = note frontmatter. 'inactive' = loaded but not active for this note. */
  plugins: Array<{ id: string; source: 'workspace' | 'default' | 'extension' | 'frontmatter' | 'inactive' }>
}

/**
 * WorkspaceManager — orchestrates panels, views and layout.
 * Does NOT depend on Dockview directly; delegates to WorkspacePort.
 * see ADR-011
 */
export class WorkspaceManagerImpl implements WorkspaceAPI {
  readonly views: ViewRegistryImpl
  private activeDocument: ViewDocument | undefined
  private openFileCallbacks: ((path: string) => void)[] = []
  private vaultChangeCallbacks: (() => void)[] = []
  private activeEditorCallbacks: ((info: ActiveEditorInfo) => void)[] = []
  private activeDocumentCallbacks: ((path: string) => void)[] = []
  private documentIndexedCallbacks: ((docId: string, path: string) => void)[] = []

  constructor(private readonly port: WorkspacePort) {
    this.views = new ViewRegistryImpl()
  }

  async openFile(path: string): Promise<void> {
    this.activeDocument = { path, content: '' }
    this.port.openPanel('editor-area', { title: path })
    for (const cb of this.openFileCallbacks) cb(path)
  }

  /**
   * Subscribe to openFile events — used by EditorAreaWidget to know when
   * a file was selected in the filetree and load its content.
   * Returns an unsubscribe function.
   */
  subscribeOpenFile(cb: (path: string) => void): () => void {
    this.openFileCallbacks.push(cb)
    return () => {
      this.openFileCallbacks = this.openFileCallbacks.filter(x => x !== cb)
    }
  }

  subscribeActiveDocument(cb: (path: string) => void): () => void {
    this.activeDocumentCallbacks.push(cb)
    return () => { this.activeDocumentCallbacks = this.activeDocumentCallbacks.filter(x => x !== cb) }
  }

  subscribeDocumentIndexed(cb: (docId: string, path: string) => void): () => void {
    this.documentIndexedCallbacks.push(cb)
    return () => { this.documentIndexedCallbacks = this.documentIndexedCallbacks.filter(x => x !== cb) }
  }

  notifyDocumentIndexed(docId: string, path: string): void {
    for (const cb of this.documentIndexedCallbacks) cb(docId, path)
  }

  /** Called by EditorArea on Dockview panel focus change (tab switch or new panel). */
  notifyActiveDocument(path: string): void {
    this.activeDocument = { path, content: this.activeDocument?.content ?? '' }
    for (const cb of this.activeDocumentCallbacks) cb(path)
  }

  subscribeVaultChange(cb: () => void): () => void {
    this.vaultChangeCallbacks.push(cb)
    return () => { this.vaultChangeCallbacks = this.vaultChangeCallbacks.filter(x => x !== cb) }
  }

  notifyVaultChange(): void {
    for (const cb of this.vaultChangeCallbacks) cb()
  }

  subscribeActiveEditor(cb: (info: ActiveEditorInfo) => void): () => void {
    this.activeEditorCallbacks.push(cb)
    return () => { this.activeEditorCallbacks = this.activeEditorCallbacks.filter(x => x !== cb) }
  }

  notifyActiveEditor(info: ActiveEditorInfo): void {
    for (const cb of this.activeEditorCallbacks) cb(info)
  }

  openPanel(panelId: string): void {
    this.port.openPanel(panelId)
  }

  closePanel(panelId: string): void {
    this.port.closePanel(panelId)
  }

  focusPanel(panelId: string): void {
    this.port.focusPanel(panelId)
  }

  getActiveDocument(): ViewDocument | undefined {
    return this.activeDocument
  }

  /** Called by the editor after CRDT content is loaded — updates activeDocument.content. */
  setActiveDocumentContent(content: string): void {
    if (this.activeDocument) {
      this.activeDocument = { ...this.activeDocument, content }
    }
  }

  saveLayout(): WorkspaceLayout {
    return this.port.saveLayout()
  }

  restoreLayout(layout: WorkspaceLayout): void {
    this.port.restoreLayout(layout)
  }
}
