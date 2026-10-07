// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { ViewRegistry, ViewSpec, ViewGroup } from '@savoire/plugin-api'

interface GroupEntry { group: ViewGroup; pluginId?: string }
interface SpecEntry  { spec: ViewSpec;  pluginId?: string }

/** Sous-ensemble structurel de PluginActivation (@savoire/plugin-runtime). */
interface ActivationLike { isEnabled(pluginId: string | undefined): boolean }

export class ViewRegistryImpl implements ViewRegistry {
  private readonly specs  = new Map<string, SpecEntry>()
  private readonly groups = new Map<string, GroupEntry>()
  private _currentPlugin: string | undefined
  private activation: ActivationLike | undefined

  /** Vue d'un plugin desactive : masquee, pas supprimee. */
  private live(pluginId: string | undefined): boolean {
    return !this.activation || this.activation.isEnabled(pluginId)
  }

  // ── ViewSpec ──────────────────────────────────────────────────────────────

  register(spec: ViewSpec): void {
    this.specs.set(spec.id, { spec, pluginId: this._currentPlugin })
  }

  unregister(id: string): void {
    this.specs.delete(id)
  }

  getAll(): ViewSpec[] {
    return Array.from(this.specs.values()).filter(e => this.live(e.pluginId)).map(e => e.spec)
  }

  get(id: string): ViewSpec | undefined {
    const entry = this.specs.get(id)
    return entry && this.live(entry.pluginId) ? entry.spec : undefined
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
    return Array.from(this.groups.values()).filter(e => this.live(e.pluginId)).map(e => e.group)
  }

  getGroup(id: string): ViewGroup | undefined {
    const entry = this.groups.get(id)
    return entry && this.live(entry.pluginId) ? entry.group : undefined
  }

  // ── Plugin lifecycle ──────────────────────────────────────────────────────

  _setCurrentPlugin(pluginId: string | undefined): void {
    this._currentPlugin = pluginId
  }

  _setActivation(activation: ActivationLike): void {
    this.activation = activation
  }

  /** Vues et groupes d'un plugin desactive : pour fermer leurs panneaux ouverts. */
  _hiddenIds(): string[] {
    const ids: string[] = []
    for (const [id, e] of this.specs) if (!this.live(e.pluginId)) ids.push(id)
    for (const [id, e] of this.groups) if (!this.live(e.pluginId)) ids.push(id)
    return ids
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
