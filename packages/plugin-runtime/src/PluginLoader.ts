// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI, IPluginLoader } from '@savoire/plugin-api'
import { PluginSandbox } from './PluginSandbox'
import { BlockRegistryImpl } from './PluginRegistries'

export interface PluginEntry {
  id: string
  sandbox: PluginSandbox | null
  plugin: VaultPlugin | null
}

// see ADR-014
export class PluginLoader implements IPluginLoader {
  private loaded = new Map<string, PluginEntry>()

  async loadFromCode(id: string, code: string, api: PluginAPI): Promise<void> {
    if (this.loaded.has(id)) {
      console.warn(`[PluginLoader] Plugin '${id}' is already loaded. Unloading first.`)
      await this.unload(id)
    }

    const sandbox = new PluginSandbox()
    await sandbox.load(code, api)
    this.loaded.set(id, { id, sandbox, plugin: null })
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
    if (api.blocks instanceof BlockRegistryImpl) {
      api.blocks._currentPluginId = id
    }
    await plugin.onload(api)
    if (api.blocks instanceof BlockRegistryImpl) {
      api.blocks._currentPluginId = undefined
    }
    this.loaded.set(id, { id, sandbox: null, plugin })
    console.log(`[PluginLoader] Internal plugin loaded: ${id}`)
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
