// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La PluginAPI « sans ecran » du pair (ADR-033) : ce qu'il faut aux outils
// d'agent des plugins pour tourner ici, pour une IA externe.
//
// Un plugin est charge UNE fois (onload) avec cette API. Ses outils, eux,
// s'executent pour un appel `tools.call` precis (personne, ticket, ACL) :
// l'appel en cours est porte par un AsyncLocalStorage, et chaque methode de
// l'API le retrouve. Hors appel (pendant onload), le vault est vide.
//
// Sur le pair :
//  - vault.read, readDocumentByPath, list, exists, resolveDocumentId,
//    getFileTree : les journaux Yjs et l'arborescence, filtres par l'ACL ;
//  - vault.editText, write, createFile, createFolder : difference Yjs, envoyee
//    au serveur avec le ticket de l'appel ;
//  - vault.moveFiles : le canal des deplacements (les liens suivent) ;
//  - vault.openTree : l'arbre partage d'un document (un dessin), rejoue depuis
//    son journal. Il reste ouvert jusqu'a la fin de l'appel ; ce qu'on y a
//    ecrit part alors au serveur, en une difference, avec le ticket
//    (flushTrees) ;
//  - review.propose : une entree « proposal » de la carte map/review ;
//  - indexer (liens, tags), query, search : les pouvoirs locaux.
// Le reste (vues, blocs, commandes, menu /, espace de travail) est inerte : un
// onload qui enregistre une vue ne casse pas, la vue n'existe simplement pas.
// Pas de sharedData : un outil qui en a besoin (historique, discussions,
// lignes legeres des bases) reste dans l'appli (runtime 'app').
import { AsyncLocalStorage } from 'node:async_hooks'
import { editDoc, type DocEdit } from '@savoire/indexer-core'
import { YjsSharedTree } from '@savoire/infrastructure-sync/shared-tree'
import type {
  AgentPreset, AgentRegistry, FileTreeEntry, IIndexerAPI, IQueryEngine, ISearchEngine, ISharedTree, IndexState,
  PluginAPI, PluginManifest, PluginTool, ReviewAPI, ToolActor, VaultAPI,
} from '@savoire/plugin-api'
import type { PeerToolHost } from './agentTools'

/** L'appel en cours : l'hote (ticket, ACL) et ce qu'on sait du vault. */
export interface PluginCallScope {
  host: PeerToolHost
  actor: ToolActor
  mode: 'direct' | 'propose'
  /** Titre de l'outil : il signe la trace de chaque ecriture. */
  tool: string
  /** id -> chemin des notes visibles, lu avant l'appel, tenu a jour par ses ecritures. */
  paths: Map<string, string>
  /** Les arbres ouverts pendant l'appel (openTree), envoyes a la fin (flushTrees). */
  trees?: Map<string, { edit: DocEdit; tree: ISharedTree }>
}

const scopes = new AsyncLocalStorage<PluginCallScope>()

/** Execute `fn` pour un appel : les API des plugins lisent et ecrivent dans ce vault. */
export function runInScope<T>(scope: PluginCallScope, fn: () => Promise<T>): Promise<T> {
  return scopes.run(scope, fn)
}

const READY: IndexState = { status: 'ready' }

function current(): PluginCallScope {
  const s = scopes.getStore()
  if (!s) throw new Error('Pas de vault ici : un outil d’agent seulement.')
  return s
}

function idOf(s: PluginCallScope, path: string): string | undefined {
  for (const [id, p] of s.paths) if (p === path) return id
  return undefined
}

function mustId(s: PluginCallScope, path: string): string {
  const id = idOf(s, path)
  if (!id) throw new Error(`Note introuvable : ${path}.`)
  return id
}

const visibleItems = <T extends { id: string }>(items: T[] | undefined): T[] => {
  const s = scopes.getStore()
  return (items ?? []).filter(i => !s || s.paths.has(i.id))
}

async function edit(docId: string, change: (text: string) => string): Promise<boolean> {
  const s = current()
  const changed = await s.host.editNote(docId, change)
  if (changed) await s.host.recordEdit(docId, s.tool, s.actor)
  return changed
}

/**
 * Envoie ce que l'appel a ecrit dans les arbres ouverts (un dessin...), un
 * document apres l'autre, avec la trace signee de l'agent. A appeler quand
 * l'outil a fini sans erreur.
 */
export async function flushTrees(s: PluginCallScope): Promise<void> {
  for (const [docId, t] of s.trees ?? []) {
    const update = t.edit.changes()
    if (!update) continue
    await s.host.writeDocument(docId, update)
    t.edit.sent()
    await s.host.recordEdit(docId, s.tool, s.actor)
  }
}

function vaultApi(): VaultAPI {
  return {
    read: id => current().host.noteText(id),
    readDocumentByPath: path => { const s = current(); return s.host.noteText(mustId(s, path)) },
    write: async (id, content) => { await edit(id, () => content) },
    editText: edit,
    list: async dir => {
      const s = scopes.getStore()
      if (!s) return []
      const prefix = dir ? (dir.endsWith('/') ? dir : `${dir}/`) : ''
      const out = new Set<string>()
      for (const p of s.paths.values()) {
        if (!p.startsWith(prefix)) continue
        const rest = p.slice(prefix.length)
        const i = rest.indexOf('/')
        out.add(i < 0 ? p : `${prefix}${rest.slice(0, i)}/`)
      }
      return [...out].sort()
    },
    exists: async id => !!scopes.getStore()?.paths.has(id),
    resolveDocumentId: path => { const s = scopes.getStore(); return s ? idOf(s, path) : undefined },
    getFileTree: () => {
      const s = scopes.getStore()
      return s ? [...s.paths].map(([docId, path]) => ({ docId, path }) as unknown as FileTreeEntry) : []
    },
    createFile: async path => {
      const s = current()
      if (idOf(s, path)) throw new Error(`Une note existe déjà : ${path}.`)
      const { id } = await s.host.createNote(path, '')
      s.paths.set(id, path)
    },
    createFolder: async path => { await current().host.createFolder(path.replace(/\/+$/, '')) },
    moveFiles: async moves => {
      const s = current()
      const n = await s.host.moveFiles(moves)
      s.paths = await s.host.visiblePaths()
      return n
    },
    renameFile: async (id, newPath) => {
      const s = current()
      const from = s.paths.get(id)
      if (!from) throw new Error('Note introuvable.')
      await s.host.moveFiles([{ from, to: newPath }])
      s.paths.set(id, newPath)
    },
    openTree: async docId => {
      const s = current()
      s.trees ??= new Map()
      const open = s.trees.get(docId)
      if (open) return open.tree
      const edit = editDoc(await s.host.docUpdates(docId))
      const tree = new YjsSharedTree(edit.doc) as ISharedTree
      s.trees.set(docId, { edit, tree })
      return tree
    },
    // Rien a fermer ici : l'arbre vit jusqu'a la fin de l'appel, ses changements partent alors.
    closeTree: () => {},
    getCurrentUser: () => {
      const s = scopes.getStore()
      return s ? { id: s.actor.onBehalfOf.userId, name: s.actor.onBehalfOf.displayName } : null
    },
  }
}

function reviewApi(): ReviewAPI {
  return {
    registerProposalType: () => () => {},
    propose: (docId, type, payload, note) => { const s = current(); return s.host.propose(docId, type, payload, note ?? '', s.actor) },
    list: () => [],
    onChange: () => () => {},
    suggesting: false,
    onSuggestingChange: () => () => {},
    // Pas de personne devant un document ici : pas d'annotations a afficher.
    inline: false,
    onInlineChange: () => () => {},
    annotations: () => [],
    comment: async () => { throw new Error('Commenter n’est pas disponible sur le pair indexeur.') },
    reply: async () => { throw new Error('Répondre n’est pas disponible sur le pair indexeur.') },
    accept: async () => { throw new Error('Accepter n’est pas disponible sur le pair indexeur.') },
    reject: async () => { throw new Error('Refuser n’est pas disponible sur le pair indexeur.') },
    resolve: async () => { throw new Error('Résoudre n’est pas disponible sur le pair indexeur.') },
  }
}

function indexerApi(): IIndexerAPI {
  const power = async (capability: string, method: string, params: Record<string, unknown>) => current().host.power(capability, method, params)
  return {
    available: () => true,
    state: () => READY,
    onStateChange: () => () => {},
    links: {
      backlinks: async p => { const r = await power('links', 'backlinks', p) as { items: never[] }; return { items: visibleItems(r?.items) } },
      outgoing: async p => (await power('links', 'outgoing', p)) as never,
      citing: async p => { const r = await power('links', 'citing', p) as { items: never[] }; return { items: visibleItems(r?.items) } },
      unresolved: async (p = {}) => (await power('links', 'unresolved', p)) as never,
      graph: async (p = {}) => (await power('links', 'graph', p)) as never,
    },
    tags: {
      list: async (p = {}) => (await power('tags', 'list', p)) as never,
      notes: async p => { const r = await power('tags', 'notes', p) as { items: never[] }; return { items: visibleItems(r?.items) } },
    },
    blocks: {
      list: async p => (await power('blocks', 'list', p)) as never,
      find: async p => { const r = await power('blocks', 'find', p) as { items: never[] }; return { items: visibleItems(r?.items) } },
      shared: async p => (await power('blocks', 'shared', p)) as never,
    },
    status: async () => ({ ...READY, docs: scopes.getStore()?.paths.size ?? 0 }),
  }
}

function queryApi(): IQueryEngine {
  return {
    query: async q => (await current().host.power('query', 'run', q as unknown as Record<string, unknown>)) as never,
    watch: () => () => {},
    state: () => READY,
    onStateChange: () => () => {},
  }
}

function searchApi(): ISearchEngine {
  return {
    search: async q => {
      const s = current()
      const hits = await s.host.search({ text: String((q as { text?: unknown }).text ?? ''), limit: Number((q as { limit?: unknown }).limit ?? 20) || 20 })
      return { hits: hits.map(h => ({ id: h.id, path: h.path, title: h.title ?? h.path, snippets: (h.snippets ?? []).map(text => ({ text })) })) } as never
    },
    state: () => READY,
    onStateChange: () => () => {},
  }
}

/** Un registre qui accepte tout et ne fait rien (vues, blocs, commandes...). */
function inert(): unknown {
  const noop = (): (() => void) => () => {}
  return new Proxy({}, {
    get: (_t, key) => (typeof key === 'symbol' || key === 'then' ? undefined : noop),
  })
}

export interface HeadlessPlugin {
  manifest: PluginManifest
  api: PluginAPI
  tools: PluginTool[]
  presets: AgentPreset[]
}

/** L'API d'un plugin sur le pair. Ses outils et modeles d'agent sont gardes ici. */
export function headlessPluginAPI(manifest: PluginManifest): HeadlessPlugin {
  const tools: PluginTool[] = []
  const presets: AgentPreset[] = []
  const agents: AgentRegistry = {
    registerTool: t => { tools.push(t); return () => { tools.splice(tools.indexOf(t), 1) } },
    tools: () => [...tools],
    registerPreset: p => { presets.push(p); return () => { presets.splice(presets.indexOf(p), 1) } },
    presets: () => [...presets],
  }
  const api = {
    vault: vaultApi(),
    review: reviewApi(),
    indexer: indexerApi(),
    query: queryApi(),
    search: searchApi(),
    agents,
    commands: inert(), hooks: inert(), blocks: inert(), files: inert(), workspace: inert(), views: inert(),
    slash: inert(), triggers: inert(), editor: inert(), toolbar: inert(),
  } as unknown as PluginAPI
  return { manifest, api, tools, presets }
}
