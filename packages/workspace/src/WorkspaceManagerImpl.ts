// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { WorkspaceAPI, ViewDocument, ViewSpec, ViewContext } from '@savoire/plugin-api'
import type { WorkspacePaneState, WorkspacePort, WorkspaceLayout, PanelLocation } from './types'
import { ViewRegistryImpl } from './ViewRegistryImpl'

export interface RibbonItem {
  type: 'group' | 'view'
  id: string
  title: string
  icon?: string
  container: 'left' | 'right'
}

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
  private readonly paneStates: Record<'left' | 'right', WorkspacePaneState> = {
    left: { collapsed: true },
    right: { collapsed: false },
  }
  private activePanelId: string | null = null
  // ── Left pane mode system ─────────────────────────────────────────────────
  private leftMode: string | null = null
  private activeLeftPanelIds: Set<string> = new Set()
  private leftPanelAdder: ((spec: ViewSpec, ctx: ViewContext) => void) | null = null
  private leftPanelCtx: ViewContext | null = null
  // ─────────────────────────────────────────────────────────────────────────
  private openFileCallbacks: ((path: string) => void)[] = []
  private vaultChangeCallbacks: (() => void)[] = []
  private activeEditorCallbacks: ((info: ActiveEditorInfo) => void)[] = []
  private activeDocumentCallbacks: ((path: string) => void)[] = []
  private documentIndexedCallbacks: ((docId: string, path: string) => void)[] = []
  private activeViewCallbacks: ((id: string | null) => void)[] = []
  private paneStateCallbacks: Record<'left' | 'right', Array<(state: WorkspacePaneState) => void>> = {
    left: [],
    right: [],
  }

  constructor(private readonly port: WorkspacePort) {
    this.views = new ViewRegistryImpl()
    port.subscribeActivePanelChange(id => {
      this.activePanelId = id
      for (const cb of this.activeViewCallbacks) cb(id)
    })
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

  collapsePane(location: 'left' | 'right'): void {
    if (this.paneStates[location].collapsed) return
    const opposite = location === 'left' ? 'right' : 'left'
    const oppositeIds = this.getPanePanelIds(opposite)
    // Read actual dockview width — paneStates may lag behind real layout at startup.
    const oppositeWidth = this.port.getPaneWidth(oppositeIds)
    this.port.collapsePane(location, this.getPanePanelIds(location))
    if (oppositeWidth > 0) this.port.setPaneWidth(oppositeIds, oppositeWidth)
    this.paneStates[location] = { collapsed: true }
    this.emitPaneState(location)
  }

  expandPane(location: 'left' | 'right'): void {
    if (!this.paneStates[location].collapsed) return
    const opposite = location === 'left' ? 'right' : 'left'
    const oppositeIds = this.getPanePanelIds(opposite)
    const oppositeWidth = this.port.getPaneWidth(oppositeIds)
    this.port.expandPane(location, this.getPanePanelIds(location))
    if (oppositeWidth > 0) this.port.setPaneWidth(oppositeIds, oppositeWidth)
    this.paneStates[location] = { collapsed: false }
    this.emitPaneState(location)
  }

  togglePane(location: 'left' | 'right'): void {
    if (location === 'left') {
      if (!this.paneStates.left.collapsed) {
        this.collapsePane('left')
        return
      }
      // Left pane has no panels yet — open the first available left mode
      if (this.activeLeftPanelIds.size === 0) {
        const firstGroup = this.views.getGroups().find(g => g.container === 'left')
        if (firstGroup) { this.switchLeftMode(firstGroup.id); return }
        const firstView = this.views.getAll().find(v => this.effectiveContainer(v) === 'left')
        if (firstView) { this.switchLeftMode(firstView.id); return }
        return
      }
      this.expandPane('left')
      return
    }
    if (this.paneStates.right.collapsed) {
      this.expandPane('right')
    } else {
      this.collapsePane('right')
    }
  }

  getPaneState(location: 'left' | 'right'): WorkspacePaneState {
    return this.paneStates[location]
  }

  subscribePaneState(location: 'left' | 'right', cb: (state: WorkspacePaneState) => void): () => void {
    this.paneStateCallbacks[location].push(cb)
    return () => {
      this.paneStateCallbacks[location] = this.paneStateCallbacks[location].filter(x => x !== cb)
    }
  }

  getPanelLocation(panelId: string): PanelLocation | undefined {
    return this.views.getAll().find(view => view.id === panelId)?.container as PanelLocation | undefined
  }

  getPaneAnchorPanelId(location: 'left' | 'right'): string | undefined {
    return this.views.getAll().find(view =>
      this.effectiveContainer(view) === location &&
      !view.tabOf &&
      !view.belowOf,
    )?.id
  }

  getPaneWidth(location: 'left' | 'right'): number {
    return this.port.getPaneWidth(this.getPanePanelIds(location))
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

  // ── Ribbon ──────────────────────────────────────────────────────────────────

  getRibbonItems(): RibbonItem[] {
    const groupItems = this.views.getGroups()
      .filter(g => g.ribbon)
      .map(g => ({ type: 'group' as const, id: g.id, title: g.title, icon: g.icon, container: g.container }))

    // Standalone views (no groupId) AND views inside a group that explicitly opt into the ribbon
    const viewItems = this.views.getAll()
      .filter(v => v.ribbon)
      .map(v => ({
        type: 'view' as const,
        id: v.id,
        title: v.title,
        icon: v.icon,
        container: this.effectiveContainer(v) as 'left' | 'right',
      }))

    return [...groupItems, ...viewItems]
  }

  subscribeActiveView(cb: (id: string | null) => void): () => void {
    this.activeViewCallbacks.push(cb)
    return () => {
      const i = this.activeViewCallbacks.indexOf(cb)
      if (i !== -1) this.activeViewCallbacks.splice(i, 1)
    }
  }

  getActivePanelId(): string | null {
    return this.activePanelId
  }

  /** Opens a left-pane group once — idempotent, safe to call from onReady even under StrictMode. */
  openDefaultLeft(groupId: string): void {
    if (this.leftMode !== null) return
    requestAnimationFrame(() => {
      if (this.leftMode !== null) return
      this.switchLeftMode(groupId)
    })
  }

  /** Called by WorkspaceRoot after initial panel setup to enable lazy left panel creation. */
  setLeftPanelAdder(fn: (spec: ViewSpec, ctx: ViewContext) => void, ctx: ViewContext): void {
    this.leftPanelAdder = fn
    this.leftPanelCtx = ctx
  }

  toggleGroup(groupId: string): void {
    const group = this.views.getGroups().find(g => g.id === groupId)
    if (!group) return
    const location = group.container as 'left' | 'right'
    if (location !== 'left' && location !== 'right') return

    if (location === 'left') {
      if (!this.paneStates.left.collapsed && this.leftMode === groupId) {
        this.collapsePane('left')
      } else {
        if (this.leftMode !== groupId) this.switchLeftMode(groupId)
        else this.expandPane('left')
      }
      return
    }

    // Right pane: standard focus-or-collapse behavior
    const groupViewIds = this.views.getAll()
      .filter(v => v.groupId === groupId)
      .map(v => v.id)
    if (groupViewIds.length === 0) return
    const paneCollapsed = this.paneStates.right.collapsed
    const activeIsInGroup = this.activePanelId !== null && groupViewIds.includes(this.activePanelId)
    if (!paneCollapsed && activeIsInGroup) {
      this.collapsePane('right')
    } else {
      if (paneCollapsed) this.expandPane('right')
      this.port.focusPanel(groupViewIds[0])
    }
  }

  toggleView(viewId: string): void {
    const view = this.views.getAll().find(v => v.id === viewId)
    if (!view) return
    const location = this.effectiveContainer(view) as 'left' | 'right'
    if (location !== 'left' && location !== 'right') return

    if (location === 'left') {
      // For left pane, the "mode" is the view itself (standalone views like search, hashtags)
      const modeId = view.groupId ?? viewId
      if (!this.paneStates.left.collapsed && this.leftMode === modeId) {
        this.collapsePane('left')
      } else {
        if (this.leftMode !== modeId) this.switchLeftMode(modeId)
        else this.expandPane('left')
      }
      return
    }

    // Right pane
    const paneCollapsed = this.paneStates.right.collapsed
    const isActive = this.activePanelId === viewId
    if (!paneCollapsed && isActive) {
      this.collapsePane('right')
    } else {
      if (paneCollapsed) this.expandPane('right')
      this.port.focusPanel(viewId)
    }
  }

  private switchLeftMode(modeId: string): void {
    const adder = this.leftPanelAdder
    const ctx = this.leftPanelCtx
    if (!adder || !ctx) return

    // Snapshot right pane width before any dockview operations — adding/removing panels
    // triggers a relayout that can squeeze the right pane to its minimum.
    const rightIds = this.getPanePanelIds('right')
    const rightWidthSnapshot = this.port.getPaneWidth(rightIds)

    // Remove all current left panels
    for (const id of this.activeLeftPanelIds) {
      this.port.closePanel(id)
    }
    this.activeLeftPanelIds = new Set()

    const group = this.views.getGroups().find(g => g.id === modeId)
    if (group) {
      // Group mode: add all views belonging to this group
      const groupViews = this.views.getAll().filter(v => v.groupId === modeId)
      const anchor = groupViews.find(v => !v.belowOf && !v.tabOf) ?? groupViews[0]
      if (!anchor) return
      // Anchor goes into the left pane with no relative positioning
      adder({ ...anchor, container: group.container as 'left', belowOf: undefined, tabOf: undefined }, ctx)
      this.activeLeftPanelIds.add(anchor.id)
      // Dependents preserve their belowOf/tabOf within the group
      for (const v of groupViews) {
        if (v === anchor) continue
        adder({ ...v, container: group.container as 'left' }, ctx)
        this.activeLeftPanelIds.add(v.id)
      }
    } else {
      // Single view mode
      const view = this.views.getAll().find(v => v.id === modeId)
      if (!view) return
      adder({ ...view, container: (view.container ?? 'left') as 'left', belowOf: undefined, tabOf: undefined }, ctx)
      this.activeLeftPanelIds.add(view.id)
    }

    this.leftMode = modeId
    this.paneStates.left = { collapsed: true }
    this.expandPane('left')
    // Dockview relayout is synchronous but the resize calculation happens in the next frame.
    // Restore right pane to its pre-switch width so only the center editor absorbs the change.
    if (rightWidthSnapshot > 0) {
      requestAnimationFrame(() => this.port.setPaneWidth(rightIds, rightWidthSnapshot))
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private effectiveContainer(spec: { container?: string; groupId?: string }): string {
    if (spec.groupId) {
      const group = this.views.getGroup(spec.groupId)
      if (group) return group.container
    }
    return spec.container ?? ''
  }

  private getPanePanelIds(location: 'left' | 'right'): string[] {
    if (location === 'left') return [...this.activeLeftPanelIds]
    return this.views.getAll()
      .filter(view => this.effectiveContainer(view) === 'right')
      .map(view => view.id)
  }

  private emitPaneState(location: 'left' | 'right'): void {
    const state = this.paneStates[location]
    for (const cb of this.paneStateCallbacks[location]) cb(state)
  }
}
