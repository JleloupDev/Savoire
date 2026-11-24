// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Un plugin du Savoire Store, transforme en plugin comme les autres
// (VaultPlugin) : il entre dans le catalogue, s'installe pour tout le vault,
// s'active et se desactive comme un plugin livre avec Savoire.
//
// Deux facons de tourner, choisies par le manifeste signe (« runtime ») :
//
//  - 'page' (defaut) : dans la page, avec toute l'API de Savoire (vues,
//    editeurs de fichiers, blocs, CRDT, revision...), comme un plugin
//    d'Obsidian. Le code est un module CommonJS (main.js) ; il recoit l'API
//    filtree par les droits de son manifeste (PermissionFilteredAPI) et les
//    bibliotheques communes (React, CodeMirror...) par require().
//  - 'frame' : dans une iframe cachee et isolee (FramedPlugin), pour un
//    plugin qui veut se passer de l'acces a la page. Il n'a que l'API
//    reduite du cadre (commandes, extracteurs, lecture du vault...).
//
// Un plugin du store n'est jamais « official » (livre avec Savoire) ; il est
// « verified » (relu par l'equipe Savoire), voir manifestOfPackage. Le pair
// indexeur gere n'execute pas le code des paquets du store pour l'instant.
import type { PluginAPI, PluginManifest, PluginPermission, VaultPlugin } from '@savoire/plugin-api'
import { UnknownLibraryError } from '@savoire/plugin-api'
import { PermissionFilteredAPI } from './PermissionFilteredAPI'
import { wrapCommonJs } from './PluginSandbox'
import { requiredLibraries, type SharedLibraryRegistry } from './SharedLibraryRegistry'
import { FramedPlugin } from './FramedPlugin'
import type { StorePackage } from './StorePackage'
import { StorePackageError } from './StorePackage'

export type StorePluginRuntime = 'page' | 'frame'

/** Comment ce paquet tourne (manifeste signe). Defaut : dans la page. */
export function runtimeOf(pkg: StorePackage): StorePluginRuntime {
  return pkg.manifest.runtime === 'frame' ? 'frame' : 'page'
}

/** Le manifeste d'un paquet, tel que le catalogue de Savoire le lit. */
export function manifestOfPackage(pkg: StorePackage): PluginManifest {
  const m = pkg.manifest
  const scope = m.scope === 'personal' ? 'personal' : 'vault'
  return {
    id: pkg.id,
    name: typeof m.name === 'string' && m.name ? m.name : pkg.id,
    version: pkg.version,
    description: typeof m.description === 'string' ? m.description : undefined,
    author: typeof m.author === 'string' ? m.author : undefined,
    permissions: (Array.isArray(m.permissions) ? m.permissions : []).filter((p): p is PluginPermission => typeof p === 'string'),
    defaultActive: m.defaultActive === true,
    contentPatterns: Array.isArray(m.contentPatterns) ? m.contentPatterns.filter((p): p is string => typeof p === 'string') : undefined,
    scope,
    // Jamais 'official' : ce niveau est celui des plugins livres avec Savoire.
    official: false,
    // Les plugins du store sont tous relus par l'equipe Savoire (decision du
    // 19/11 : leur auteur est celui de Savoire). Quand des tiers publieront,
    // le store dira le niveau dans le manifeste signe (champ `trust`), et un
    // paquet non relu sera 'unverified'.
    trust: m.trust === 'unverified' ? 'unverified' : 'verified',
    capabilities: Array.isArray(m.capabilities) ? m.capabilities.filter((c): c is string => typeof c === 'string') : undefined,
  } as PluginManifest
}

let requireSeq = 0

/** Evalue un main.js CommonJS dans la page. Rend ce qu'il exporte. */
export async function evaluateCommonJs(code: string, libraries?: SharedLibraryRegistry): Promise<unknown> {
  const wanted = requiredLibraries(code)
  if (libraries) await libraries.loadAll(wanted)
  else if (wanted.length) throw new UnknownLibraryError(wanted[0])
  const key = `__savoireRequire${++requireSeq}`
  // Garde en place : un plugin peut appeler require() plus tard.
  ;(globalThis as Record<string, unknown>)[key] = libraries?.createRequire()
    ?? ((id: string) => { throw new UnknownLibraryError(id) })
  const url = URL.createObjectURL(new Blob([wrapCommonJs(code, key)], { type: 'text/javascript' }))
  try {
    const mod = await import(/* @vite-ignore */ url) as { default?: unknown }
    return mod.default
  } finally {
    URL.revokeObjectURL(url)
  }
}

interface PluginExports {
  onload(api: PluginAPI): unknown
  onunload?(): unknown
}

const isPluginExports = (x: unknown): x is PluginExports =>
  !!x && typeof (x as PluginExports).onload === 'function'

export interface StorePluginOptions {
  libraries?: SharedLibraryRegistry
  /** Un message du plugin a la personne (runtime 'frame' : api.notify). */
  notify?: (message: string) => void
  onError?: (message: string) => void
}

/**
 * Le plugin d'un paquet verifie (verifyStorePackage). Le code n'est evalue
 * qu'au chargement (onload), pas a la construction.
 */
export function storePlugin(pkg: StorePackage, opts: StorePluginOptions = {}): VaultPlugin {
  const manifest = manifestOfPackage(pkg)
  const code = pkg.files['main.js']
  if (typeof code !== 'string') throw new StorePackageError('Paquet sans main.js.')
  const permissions = new Set<PluginPermission>(manifest.permissions ?? [])

  if (runtimeOf(pkg) === 'frame') {
    let framed: FramedPlugin | null = null
    return {
      manifest,
      async onload(api) {
        framed = new FramedPlugin({
          id: pkg.id, name: manifest.name, code, permissions: [...permissions], api,
          notify: opts.notify, onError: opts.onError,
        })
        await framed.start()
      },
      async onunload() { await framed?.stop(); framed = null },
    }
  }

  let exports: PluginExports | null = null
  return {
    manifest,
    async onload(api) {
      const loaded = await evaluateCommonJs(code, opts.libraries)
      const candidate = (loaded as { default?: unknown } | null)?.default ?? loaded
      if (!isPluginExports(candidate)) {
        throw new StorePackageError('Le paquet doit exporter { onload(api), onunload() } (module.exports).')
      }
      exports = candidate
      await exports.onload(new PermissionFilteredAPI(api, permissions))
    },
    async onunload() {
      const e = exports
      exports = null
      await e?.onunload?.()
    },
  }
}
