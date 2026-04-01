// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// Workspace layout types — Panels, Views, Layout persistence.
// see ADR-011

export type PanelLocation = 'left' | 'right' | 'bottom' | 'center'

export interface PanelSpec {
  id: string
  location: PanelLocation
}

export interface PanelState {
  id: string
  location: PanelLocation
  views: string[]
}

export interface WorkspaceLayout {
  panels: PanelState[]
}

export interface OpenPanelOptions {
  title?: string
  component?: string
}

export interface PanelInstance {
  id: string
  focus(): void
  close(): void
}

// ─── WorkspacePort — abstraction over the layout engine ───────────────────

/** Port implemented by DockviewAdapter (or any other layout engine). */
export interface WorkspacePort {
  openPanel(panelId: string, options?: OpenPanelOptions): PanelInstance
  closePanel(panelId: string): void
  focusPanel(panelId: string): void
  saveLayout(): WorkspaceLayout
  restoreLayout(layout: WorkspaceLayout): void
}
