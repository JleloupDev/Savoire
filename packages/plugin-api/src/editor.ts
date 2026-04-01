// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Editor position API ──────────────────────────────────────────────────

export interface EditorPositionAPI {
  getCursorCoords(): { x: number; y: number } | null
  getSelectionCoords(): { x: number; y: number } | null
  getSelectionText(): string
}

// ─── Toolbar commands ─────────────────────────────────────────────────────

export interface EditorCommandContext {
  // opaque — passed from EditorCore to command handlers
  // plugins receive this but treat it as a black box
}

export interface ToolbarCommand {
  id: string
  label: string
  icon: string
  group?: string              // 'format' | 'insert' | 'action'
  requiresSelection?: boolean
  hotkeys?: Array<{ modifiers: string[]; key: string }>
  run(ctx: EditorCommandContext): void
  isActive?(ctx: EditorCommandContext): boolean
  isEnabled?(ctx: EditorCommandContext): boolean
}

export interface ToolbarCommandRegistry {
  register(cmd: ToolbarCommand): void
  unregister(id: string): void
  getAll(): ToolbarCommand[]
  getByGroup(group: string): ToolbarCommand[]
}
