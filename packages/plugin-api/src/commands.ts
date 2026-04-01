// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Commands ──────────────────────────────────────────────────────────────

export interface PluginCommandContext {
  /** Raw editor view — typed as unknown to avoid direct CM6 dependency in plugin-api */
  editorView: unknown
}

export interface PluginCommand {
  id: string
  label?: string
  run(context: PluginCommandContext): void
}

export interface CommandRegistry {
  register(command: PluginCommand): void
  unregister(id: string): void
}
