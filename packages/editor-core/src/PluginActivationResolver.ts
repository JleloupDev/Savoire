// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// see ADR-012

export type ActivationSource = 'default' | 'extension' | 'frontmatter'

export interface ActivationEntry {
  id: string
  source: ActivationSource
}

export interface ActivationContext {
  /** Plugin ids whose manifest.defaultActive === true — active for every note. */
  defaultActiveIds: Set<string>
  /** Extension → pluginId mapping (e.g. 'excalidraw' → 'plugin-excalidraw'). */
  extPluginMap: Record<string, string>
  /** File path of the note being opened (null if unknown). */
  filePath: string | null
  /** Scoped plugins accumulated by prior load cycles (id → source). */
  loadedScopedPlugins: Map<string, 'extension' | 'frontmatter'>
}

/**
 * Computes the activation map for a note.
 * Priority / ordering: default → extension → frontmatter.
 * The function is purely additive — first writer wins, no evictions.
 */
export function resolveActivePlugins(ctx: ActivationContext): Map<string, ActivationEntry> {
  const result = new Map<string, ActivationEntry>()

  // 1. defaultActive plugins — always on regardless of file type or frontmatter.
  for (const id of ctx.defaultActiveIds) {
    result.set(id, { id, source: 'default' })
  }

  // 2. Extension-based plugin (e.g. note.excalidraw → plugin-excalidraw).
  const ext = ctx.filePath?.split('.').pop()?.toLowerCase()
  const extId = ext ? ctx.extPluginMap[ext] : undefined
  if (extId && !result.has(extId)) {
    result.set(extId, { id: extId, source: 'extension' })
  }

  // 3. Plugins declared in note frontmatter (accumulated across re-checks).
  for (const [id, source] of ctx.loadedScopedPlugins) {
    if (!result.has(id)) result.set(id, { id, source })
  }

  return result
}
