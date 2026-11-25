// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les plugins dont le pair execute les outils d'agent (ADR-033), pour les IA
// externes (ChatGPT, Claude par /api/mcp).
//
// Qui peut tourner ici depend du niveau de confiance du plugin (manifeste,
// voir pluginTrust) et du reglage du pair, SAVOIRE_INDEXER_PLUGIN_TRUST :
//  - 'official' : les plugins livres avec Savoire seulement ;
//  - 'verified' (defaut) : plus ceux relus par l'equipe Savoire ;
//  - 'all' : tout plugin, maison compris. Pour un pair d'organisation sur une
//    VM dediee, jamais pour le pair gere par Savoire.
// Les plugins livres avec Savoire sont dans le paquet. Une VM peut en ajouter
// (SAVOIRE_INDEXER_PLUGIN_DIR : des modules ESM .mjs, un plugin par fichier,
// `export default` un VaultPlugin), filtres par le meme reglage.
//
// Seuls les outils qui declarent le runtime 'server' sont proposes : un outil
// qui a besoin de l'ecran ou d'une carte partagee d'un document (sharedData.openMap)
// reste dans l'appli. L'arbre d'un document (openTree : un dessin, une base) et
// ses arbres annexes (les lots de lignes d'une base) sont permis ;
// ce que l'outil y ecrit part a la fin de l'appel, s'il a reussi.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  pluginTrust, trustAllowed, type PeerPluginPolicy, type PluginTool, type ToolSpec, type VaultPlugin,
} from '@savoire/plugin-api'
import taskList from '@savoire/plugin-task-list'
import templates from '@savoire/plugin-templates'
import agenda from '@savoire/plugin-agenda/server'
import mermaid from '@savoire/plugin-mermaid/server'
import hashtags from '@savoire/plugin-hashtags/server'
import excalidraw from '@savoire/plugin-excalidraw/server'
import animation from '@savoire/plugin-animation/server'
import bases from '@savoire/plugin-base/server'
import { flushTrees, headlessPluginAPI, runInScope, type HeadlessPlugin, type PluginCallScope } from './pluginApi'

/** Les plugins livres avec Savoire qui apportent des outils serveur. */
export const BUILTIN_SERVER_PLUGINS: readonly VaultPlugin[] = [taskList, agenda, templates, mermaid, hashtags, excalidraw, bases, animation]

export interface ServerPluginsOptions {
  policy: PeerPluginPolicy
  /** Dossier de plugins en plus (VM d'organisation). Vide : aucun. */
  dir?: string
  builtins?: readonly VaultPlugin[]
  warn?: (msg: string, fields?: Record<string, unknown>) => void
}

export interface ServerPluginSet {
  /** Les fiches des outils serveur des plugins acceptes. */
  specs(): Promise<ToolSpec[]>
  /** Les outils, lies a un appel (ses lectures et ecritures passent par `scope`). */
  tools(base: Omit<PluginCallScope, 'mode' | 'tool'>): Promise<PluginTool[]>
  /** Les plugins refuses par le reglage (id), pour le journal et les tests. */
  refused(): Promise<string[]>
}

const isServerTool = (t: PluginTool): boolean => (t.spec.runtimes ?? ['app']).includes('server')

async function fromDir(dir: string, warn: ServerPluginsOptions['warn']): Promise<VaultPlugin[]> {
  let files: string[]
  try { files = readdirSync(dir).filter(f => f.endsWith('.mjs')).sort() } catch { warn?.('dossier de plugins illisible', { dir }); return [] }
  const out: VaultPlugin[] = []
  for (const f of files) {
    try {
      const mod = await import(pathToFileURL(join(dir, f)).href) as { default?: VaultPlugin }
      if (mod.default?.manifest?.id && typeof mod.default.onload === 'function') out.push(mod.default)
      else warn?.('plugin ignore : export default VaultPlugin attendu', { file: f })
    } catch (err) {
      warn?.('plugin illisible', { file: f, message: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/** Charge (une fois, a la premiere demande) les plugins permis et leurs outils. */
export function serverPlugins(o: ServerPluginsOptions): ServerPluginSet {
  let loading: Promise<{ loaded: HeadlessPlugin[]; refused: string[] }> | null = null
  const load = () => loading ??= (async () => {
    const all = [...(o.builtins ?? BUILTIN_SERVER_PLUGINS), ...(o.dir ? await fromDir(o.dir, o.warn) : [])]
    const loaded: HeadlessPlugin[] = []
    const refused: string[] = []
    const seen = new Set<string>()
    for (const plugin of all) {
      const id = plugin.manifest.id
      if (seen.has(id)) continue
      seen.add(id)
      if (!trustAllowed(pluginTrust(plugin.manifest), o.policy)) {
        refused.push(id)
        o.warn?.('plugin refuse sur ce pair (niveau de confiance)', { plugin: id, trust: pluginTrust(plugin.manifest), policy: o.policy })
        continue
      }
      const h = headlessPluginAPI(plugin.manifest)
      try {
        await plugin.onload(h.api)
        loaded.push(h)
      } catch (err) {
        o.warn?.('plugin non charge', { plugin: id, message: err instanceof Error ? err.message : String(err) })
      }
    }
    return { loaded, refused }
  })()
  const serverTools = async () => (await load()).loaded.flatMap(h => h.tools.filter(isServerTool))
  return {
    specs: async () => (await serverTools()).map(t => t.spec),
    tools: async base => (await serverTools()).map(t => ({
      spec: t.spec,
      run: (args, ctx) => {
        const scope: PluginCallScope = { ...base, paths: new Map(base.paths), mode: ctx.mode, tool: t.spec.title }
        return runInScope(scope, async () => {
          const result = await t.run(args, ctx)
          // Les arbres ouverts (dessins, bases) et les types : leurs changements partent maintenant, avec le ticket de l'appel.
          await flushTrees(scope)
          return result
        })
      },
    })),
    refused: async () => (await load()).refused,
  }
}
