// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { analyzeCapabilities, type VaultPlugin, type PluginAPI, type IPluginLoader, type CapabilityReport, type PluginRegistrations } from '@savoire/plugin-api'
import { recordRegistrations } from './RegistrationRecorder'
import { PluginSandbox } from './PluginSandbox'
import { BlockRegistryImpl } from './PluginRegistries'
import type { PluginActivation } from './PluginActivation'

export interface PluginEntry {
  id: string
  sandbox: PluginSandbox | null
  plugin: VaultPlugin | null
  api: PluginAPI | null
  /** Ce que le plugin a enregistre a son chargement (plugins charges par loadInternal). */
  registrations?: PluginRegistrations
}

// see ADR-014
export class PluginLoader implements IPluginLoader {
  private loaded = new Map<string, PluginEntry>()

  /** `libraries` : les bibliotheques communes fournies aux plugins charges depuis leur code. */
  constructor(private readonly libraries?: import('./SharedLibraryRegistry').SharedLibraryRegistry) {}

  async loadFromCode(id: string, code: string, api: PluginAPI): Promise<void> {
    if (this.loaded.has(id)) {
      console.warn(`[PluginLoader] Plugin '${id}' is already loaded. Unloading first.`)
      await this.unload(id)
    }

    const sandbox = new PluginSandbox(this.libraries)
    await sandbox.load(code, api)
    this.loaded.set(id, { id, sandbox, plugin: null, api })
    console.log(`[PluginLoader] Plugin loaded: ${id}`)
  }

  async loadFromUrl(id: string, url: string, api: PluginAPI): Promise<void> {
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`[PluginLoader] Failed to fetch plugin '${id}': ${response.statusText}`)
    }
    const code = await response.text()
    await this.loadFromCode(id, code, api)
  }

  /**
   * Load a first-party plugin directly — no Blob URL sandbox, no network.
   * Every BlockSpec registered during onload() is automatically tagged with the
   * plugin's manifest id, enabling per-note activation filtering in LivePreview.
   */
  async loadInternal(plugin: VaultPlugin, api: PluginAPI): Promise<void> {
    const { id } = plugin.manifest
    if (this.loaded.has(id)) {
      console.warn(`[PluginLoader] Plugin '${id}' already loaded. Skipping.`)
      return
    }
    // Tout ce que le plugin enregistre pendant son onload porte son id : c'est
    // ce qui permet de le desactiver sans le decharger (PluginActivation).
    const activation = (api as { activation?: PluginActivation }).activation
    if (api.blocks instanceof BlockRegistryImpl) api.blocks._currentPluginId = id
    api.views._setCurrentPlugin?.(id)
    if (activation) activation.currentPluginId = id
    // Ce qu'il enregistre est releve : avec quels systemes de Savoire il marche.
    const recorded = recordRegistrations(api)
    try {
      await plugin.onload(recorded.api)
    } finally {
      if (api.blocks instanceof BlockRegistryImpl) api.blocks._currentPluginId = undefined
      api.views._setCurrentPlugin?.(undefined)
      if (activation) activation.currentPluginId = undefined
    }
    this.loaded.set(id, { id, sandbox: null, plugin, api, registrations: recorded.registrations })
    console.log(`[PluginLoader] Internal plugin loaded: ${id}`)
  }

  /** Avec quels systemes de Savoire marche ce plugin (charge). Null s'il ne l'est pas. */
  capabilitiesOf(id: string): CapabilityReport[] | null {
    const r = this.loaded.get(id)?.registrations
    return r ? analyzeCapabilities(r) : null
  }

  async unload(id: string): Promise<void> {
    const entry = this.loaded.get(id)
    if (!entry) {
      console.warn(`[PluginLoader] Plugin '${id}' is not loaded.`)
      return
    }
    if (entry.plugin) {
      await entry.plugin.onunload()
    } else {
      await entry.sandbox?.unload()
    }
    entry.api?.views._cleanupPlugin?.(id)
    this.loaded.delete(id)
    console.log(`[PluginLoader] Plugin unloaded: ${id}`)
  }

  async unloadAll(): Promise<void> {
    for (const id of this.loaded.keys()) {
      await this.unload(id)
    }
  }

  isLoaded(id: string): boolean {
    return this.loaded.has(id)
  }

  getLoadedIds(): string[] {
    return Array.from(this.loaded.keys())
  }

  getAll(): PluginEntry[] {
    return Array.from(this.loaded.values())
  }
}
