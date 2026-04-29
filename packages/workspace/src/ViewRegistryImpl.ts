// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ViewRegistry, ViewSpec, ViewGroup } from '@savoire/plugin-api'

interface GroupEntry { group: ViewGroup; pluginId?: string }
interface SpecEntry  { spec: ViewSpec;  pluginId?: string }

export class ViewRegistryImpl implements ViewRegistry {
  private readonly specs  = new Map<string, SpecEntry>()
  private readonly groups = new Map<string, GroupEntry>()
  private _currentPlugin: string | undefined

  // ── ViewSpec ──────────────────────────────────────────────────────────────

  register(spec: ViewSpec): void {
    this.specs.set(spec.id, { spec, pluginId: this._currentPlugin })
  }

  unregister(id: string): void {
    this.specs.delete(id)
  }

  getAll(): ViewSpec[] {
    return Array.from(this.specs.values()).map(e => e.spec)
  }

  get(id: string): ViewSpec | undefined {
    return this.specs.get(id)?.spec
  }

  // ── ViewGroup ─────────────────────────────────────────────────────────────

  registerGroup(group: ViewGroup): void {
    const source: ViewGroup['source'] = this._currentPlugin ? 'plugin' : 'app'
    this.groups.set(group.id, { group: { ...group, source }, pluginId: this._currentPlugin })
  }

  unregisterGroup(id: string): void {
    this.groups.delete(id)
  }

  getGroups(): ViewGroup[] {
    return Array.from(this.groups.values()).map(e => e.group)
  }

  getGroup(id: string): ViewGroup | undefined {
    return this.groups.get(id)?.group
  }

  // ── Plugin lifecycle ──────────────────────────────────────────────────────

  _setCurrentPlugin(pluginId: string | undefined): void {
    this._currentPlugin = pluginId
  }

  _cleanupPlugin(pluginId: string): void {
    for (const [id, entry] of this.groups) {
      if (entry.pluginId === pluginId) this.groups.delete(id)
    }
    for (const [id, entry] of this.specs) {
      if (entry.pluginId === pluginId) this.specs.delete(id)
    }
  }
}
