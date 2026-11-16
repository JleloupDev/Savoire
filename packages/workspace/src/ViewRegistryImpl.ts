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
  /** Panneaux retires par la disposition choisie (vue par defaut, options). */
  private hidden: ReadonlySet<string> = new Set()

  /** Vue d'un plugin desactive : masquee, pas supprimee. */
  private live(pluginId: string | undefined): boolean {
    return !this.activation || this.activation.isEnabled(pluginId)
  }

  private groupVisible(id: string): boolean {
    const entry = this.groups.get(id)
    return !!entry && this.live(entry.pluginId) && !this.hidden.has(id)
  }

  /** Une vue d'un groupe retire disparait avec lui. Un groupe inconnu ne compte pas. */
  private specVisible(e: SpecEntry): boolean {
    if (!this.live(e.pluginId) || this.hidden.has(e.spec.id)) return false
    const groupId = e.spec.groupId
    return !groupId || !this.groups.has(groupId) || this.groupVisible(groupId)
  }

  // ── ViewSpec ──────────────────────────────────────────────────────────────

  register(spec: ViewSpec): void {
    this.specs.set(spec.id, { spec, pluginId: this._currentPlugin })
  }

  unregister(id: string): void {
    this.specs.delete(id)
  }

  getAll(): ViewSpec[] {
    return Array.from(this.specs.values()).filter(e => this.specVisible(e)).map(e => e.spec)
  }

  get(id: string): ViewSpec | undefined {
    const entry = this.specs.get(id)
    return entry && this.specVisible(entry) ? entry.spec : undefined
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
    return Array.from(this.groups.values()).filter(e => this.groupVisible(e.group.id)).map(e => e.group)
  }

  getGroup(id: string): ViewGroup | undefined {
    const entry = this.groups.get(id)
    return entry && this.groupVisible(id) ? entry.group : undefined
  }

  // ── Disposition ───────────────────────────────────────────────────────────

  /** Panneaux (vues ou groupes) que la disposition retire. L'editeur reste toujours. */
  setHiddenIds(ids: Iterable<string>): void {
    this.hidden = new Set([...ids].filter(id => id !== 'editor-area'))
  }

  /**
   * Tous les panneaux de plugins actifs, presents ou retires par la
   * disposition : pour les options, qui doivent pouvoir les remettre.
   */
  listPanels(): { groups: ViewGroup[]; views: ViewSpec[] } {
    return {
      groups: Array.from(this.groups.values()).filter(e => this.live(e.pluginId)).map(e => e.group),
      views: Array.from(this.specs.values()).filter(e => this.live(e.pluginId)).map(e => e.spec),
    }
  }

  // ── Plugin lifecycle ──────────────────────────────────────────────────────

  _setCurrentPlugin(pluginId: string | undefined): void {
    this._currentPlugin = pluginId
  }

  _setActivation(activation: ActivationLike): void {
    this.activation = activation
  }

  /** Vues et groupes masques (plugin desactive, disposition) : pour fermer leurs panneaux ouverts. */
  _hiddenIds(): string[] {
    const ids: string[] = []
    for (const [id, e] of this.specs) if (!this.specVisible(e)) ids.push(id)
    for (const id of this.groups.keys()) if (!this.groupVisible(id)) ids.push(id)
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
