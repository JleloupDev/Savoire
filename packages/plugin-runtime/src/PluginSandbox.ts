// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultPlugin, PluginAPI, PluginPermission } from '@savoire/plugin-api'
import { PermissionFilteredAPI } from './PermissionFilteredAPI'

// see ADR-014
export class PluginSandbox {
  private plugin: VaultPlugin | null = null
  private blobUrl: string | null = null

  async load(code: string, api: PluginAPI): Promise<void> {
    // Wrap in a module that receives the filtered API as an import
    const wrappedCode = `
      const __api__ = globalThis.__pluginAPI__
      ${code}
    `
    const blob = new Blob([wrappedCode], { type: 'application/javascript' })
    this.blobUrl = URL.createObjectURL(blob)

    const permissions = new Set<PluginPermission>()
    ;(await import(/* @vite-ignore */ this.blobUrl)) as { default?: VaultPlugin }

    // After dynamic import — clean up blob URL
    URL.revokeObjectURL(this.blobUrl)
    this.blobUrl = null

    // The plugin module must set globalThis.__poc_plugin__
    const pluginExport = (globalThis as Record<string, unknown>).__poc_plugin__ as
      | VaultPlugin
      | undefined
    if (!pluginExport) {
      throw new Error('[PluginSandbox] Plugin did not export via globalThis.__poc_plugin__')
    }

    this.plugin = pluginExport
    pluginExport.manifest.permissions?.forEach((p) => permissions.add(p))

    const filteredAPI = new PermissionFilteredAPI(api, permissions)
    await pluginExport.onload(filteredAPI)
    console.log(`[PluginSandbox] Loaded plugin: ${pluginExport.manifest.id}`)
  }

  async unload(): Promise<void> {
    if (this.plugin) {
      await this.plugin.onunload()
      this.plugin = null
    }
  }
}
