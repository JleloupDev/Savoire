// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import { UnknownLibraryError, type VaultPlugin, type PluginAPI, type PluginPermission } from '@savoire/plugin-api'
import { PermissionFilteredAPI } from './PermissionFilteredAPI'
import { requiredLibraries, type SharedLibraryRegistry } from './SharedLibraryRegistry'

let requireSeq = 0

/**
 * Enveloppe un plugin au format CommonJS (le format des paquets de plugins,
 * comme ceux d'Obsidian) dans un module ES : `require`, `module`, `exports`
 * fournis ; l'export par defaut est le plugin.
 */
export function wrapCommonJs(code: string, requireKey: string): string {
  return `const require = globalThis[${JSON.stringify(requireKey)}];
const module = { exports: {} };
const exports = module.exports;
${code}
;export default (module.exports && module.exports.default) || module.exports;
`
}

/** Le code est-il un paquet CommonJS (sinon : l'ancien format globalThis.__poc_plugin__) ? */
export function isCommonJsPlugin(code: string): boolean {
  return !code.includes('__poc_plugin__')
}

// see ADR-014
export class PluginSandbox {
  private plugin: VaultPlugin | null = null
  private blobUrl: string | null = null

  constructor(private readonly libraries?: SharedLibraryRegistry) {}

  async load(code: string, api: PluginAPI): Promise<void> {
    if (isCommonJsPlugin(code)) return this.loadCommonJs(code, api)
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

  /**
   * Paquet CommonJS : les bibliotheques communes qu'il demande sont chargees
   * d'abord ; une bibliotheque hors liste le refuse, avec un message clair.
   */
  private async loadCommonJs(code: string, api: PluginAPI): Promise<void> {
    const wanted = requiredLibraries(code)
    if (this.libraries) await this.libraries.loadAll(wanted)
    else if (wanted.length) throw new UnknownLibraryError(wanted[0])
    const key = `__savoireRequire${++requireSeq}`
    // Garde en place : un plugin peut appeler require() plus tard.
    ;(globalThis as Record<string, unknown>)[key] = this.libraries?.createRequire()
      ?? ((id: string) => { throw new UnknownLibraryError(id) })
    const blob = new Blob([wrapCommonJs(code, key)], { type: 'application/javascript' })
    const url = URL.createObjectURL(blob)
    let mod: { default?: VaultPlugin }
    try {
      mod = await import(/* @vite-ignore */ url) as { default?: VaultPlugin }
    } finally {
      URL.revokeObjectURL(url)
    }
    const plugin = mod.default
    if (!plugin?.manifest || typeof plugin.onload !== 'function') throw new Error('[PluginSandbox] Le paquet n\'exporte pas de plugin (module.exports = { manifest, onload, onunload }).')
    this.plugin = plugin
    const filtered = new PermissionFilteredAPI(api, new Set<PluginPermission>(plugin.manifest.permissions ?? []))
    await plugin.onload(filtered)
  }

  async unload(): Promise<void> {
    if (this.plugin) {
      await this.plugin.onunload()
      this.plugin = null
    }
  }
}
