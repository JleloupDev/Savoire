// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Workspace API ─────────────────────────────────────────────────────────

export interface ViewDocument {
  path: string
  content: string
}

export interface WorkspacePaneState {
  collapsed: boolean
}

export interface WorkspaceAPI {
  openFile(path: string): Promise<void>
  openPanel(panelId: string): void
  closePanel(panelId: string): void
  collapsePane?(location: 'left' | 'right'): void
  expandPane?(location: 'left' | 'right'): void
  togglePane?(location: 'left' | 'right'): void
  getPaneState?(location: 'left' | 'right'): WorkspacePaneState
  subscribePaneState?(location: 'left' | 'right', cb: (state: WorkspacePaneState) => void): () => void
  getActiveDocument(): ViewDocument | undefined
  /** Subscribe to vault-change events (fired when selected vault changes). */
  subscribeVaultChange?(cb: () => void): () => void
  /** Notify all vault-change subscribers. */
  notifyVaultChange?(): void
  /** Subscribe to file-open events (fired when the user opens a document). */
  subscribeOpenFile?(cb: (path: string) => void): () => void
  /** Subscribe to active-document changes (fired on tab switch AND file open). */
  subscribeActiveDocument?(cb: (path: string) => void): () => void
  /** Subscribe to document-indexed events (fired after metadata extraction completes). */
  subscribeDocumentIndexed?(cb: (docId: string, path: string) => void): () => void
}
