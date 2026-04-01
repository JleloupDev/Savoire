// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { DockviewApi, IDockviewPanel } from 'dockview'
import type { WorkspacePort, WorkspaceLayout, OpenPanelOptions, PanelInstance } from './types'

/**
 * DockviewAdapter — implements WorkspacePort using the Dockview layout engine.
 * see ADR-011
 *
 * Usage: create the adapter, pass it to WorkspaceManagerImpl, then call
 * setApi() once DockviewReact fires its onReady callback.
 */
export class DockviewAdapter implements WorkspacePort {
  private api: DockviewApi | null = null

  /** Called by WorkspaceRoot once Dockview is mounted and ready. */
  setApi(api: DockviewApi): void {
    this.api = api
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
}
