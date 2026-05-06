// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DockviewApi, IDockviewPanel } from 'dockview'
import type { WorkspacePort, WorkspaceLayout, OpenPanelOptions, PanelInstance, PanelLocation } from './types'

const DEFAULT_EXPANDED_PANE_SIZE = 280

/**
 * DockviewAdapter — implements WorkspacePort using the Dockview layout engine.
 * see ADR-011
 *
 * Usage: create the adapter, pass it to WorkspaceManagerImpl, then call
 * setApi() once DockviewReact fires its onReady callback.
 */
export class DockviewAdapter implements WorkspacePort {
  private api: DockviewApi | null = null
  private readonly lastExpandedSizes: Record<'left' | 'right', number> = {
    left: DEFAULT_EXPANDED_PANE_SIZE,
    right: DEFAULT_EXPANDED_PANE_SIZE,
  }

  private readonly activePanelCallbacks: ((panelId: string | null) => void)[] = []

  /** Called by WorkspaceRoot once Dockview is mounted and ready. */
  setApi(api: DockviewApi): void {
    this.api = api
    api.onDidActivePanelChange(e => {
      const id = (e as { id?: string } | null)?.id ?? null
      for (const cb of this.activePanelCallbacks) cb(id)
    })
  }

  subscribeActivePanelChange(cb: (panelId: string | null) => void): () => void {
    this.activePanelCallbacks.push(cb)
    return () => {
      const i = this.activePanelCallbacks.indexOf(cb)
      if (i !== -1) this.activePanelCallbacks.splice(i, 1)
    }
  }

  openPanel(panelId: string, options?: OpenPanelOptions): PanelInstance {
    if (!this.api) throw new Error('DockviewAdapter: not initialized — call setApi() first')

    const existing: IDockviewPanel | undefined = this.api.getPanel(panelId)
    if (existing) {
      existing.focus()
      return this.toInstance(existing)
    }

    const panel = this.api.addPanel({
      id: panelId,
      component: options?.component ?? panelId,
      title: options?.title ?? panelId,
    })

    return this.toInstance(panel)
  }

  closePanel(panelId: string): void {
    const panel = this.api?.getPanel(panelId)
    if (panel) this.api?.removePanel(panel)
  }

  focusPanel(panelId: string): void {
    this.api?.getPanel(panelId)?.focus()
  }

  collapsePane(location: Exclude<PanelLocation, 'center'>, panelIds: string[]): void {
    const groups = this.getGroupsForPanelIds(panelIds)
    if (groups.length === 0) return

    const currentWidth = Math.max(...groups.map(group => group.width))
    if (currentWidth > 0) this.lastExpandedSizes[location] = currentWidth

    for (const group of groups) {
      // Lock width at 0: set min=0, max=0, then size=0.
      // maximumWidth: 0 prevents dockview from re-expanding the group on relayout.
      group.api.setConstraints({ minimumWidth: 0, maximumWidth: 0, minimumHeight: 0 })
      group.api.setSize({ width: 0 })
    }
  }

  expandPane(location: Exclude<PanelLocation, 'center'>, panelIds: string[]): void {
    const groups = this.getGroupsForPanelIds(panelIds)
    if (groups.length === 0) return

    const width = Math.max(this.lastExpandedSizes[location], DEFAULT_EXPANDED_PANE_SIZE)
    for (const group of groups) {
      // Release the lock, restore usable constraints, then set width.
      group.api.setConstraints({ minimumWidth: 100, maximumWidth: Number.MAX_SAFE_INTEGER, minimumHeight: 0 })
      group.api.setSize({ width })
    }
  }

  getPaneWidth(panelIds: string[]): number {
    const groups = this.getGroupsForPanelIds(panelIds)
    if (groups.length === 0) return 0
    return Math.max(...groups.map(g => g.width))
  }

  setPaneWidth(panelIds: string[], width: number): void {
    const groups = this.getGroupsForPanelIds(panelIds)
    for (const group of groups) {
      group.api.setSize({ width })
    }
  }

  saveLayout(): WorkspaceLayout {
    const panels = this.api?.panels ?? []
    return {
      panels: panels.map(p => ({
        id: p.id,
        location: 'center',
        views: [],
      })),
    }
  }

  restoreLayout(_layout: WorkspaceLayout): void {
    // TODO: implement layout persistence — see GitHub issue "Workspace: persist panel layout across sessions"
  }

  private toInstance(panel: IDockviewPanel): PanelInstance {
    return {
      id: panel.id,
      focus: () => panel.focus(),
      close: () => {
        if (this.api) this.api.removePanel(panel)
      },
    }
  }

  private getGroupsForPanelIds(panelIds: string[]) {
    if (!this.api) return []

    const groups = new Map<string, NonNullable<ReturnType<DockviewApi['getGroup']>>>()
    for (const panelId of panelIds) {
      const panel = this.api.getPanel(panelId)
      if (!panel) continue
      groups.set(panel.group.id, panel.group)
    }

    return [...groups.values()]
  }
}
