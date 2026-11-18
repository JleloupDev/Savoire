// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Releve ce qu'un plugin enregistre pendant son chargement (types de fichier,
// extracteurs, index, agents, propositions...), pour savoir avec quels
// systemes de Savoire il fonctionne (analyzeCapabilities, plugin-api). Le
// plugin recoit l'API telle quelle, enveloppee : chaque appel d'enregistrement
// est note puis transmis, sans rien changer a son effet.
import { emptyRegistrations, type PluginAPI, type PluginRegistrations } from '@savoire/plugin-api'

type Note = (args: unknown[]) => void

/** Le registre, dont la methode `method` est notee avant d'etre appelee. */
function watch<T extends object>(target: T | undefined, method: string, note: Note): T | undefined {
  if (!target) return target
  return new Proxy(target, {
    get(t, k) {
      const v = Reflect.get(t, k, t) as unknown
      if (typeof v !== 'function') return v
      if (k === method) return (...args: unknown[]) => { try { note(args) } catch { /* releve seulement */ } return (v as (...a: unknown[]) => unknown).apply(t, args) }
      return (v as (...a: unknown[]) => unknown).bind(t)
    },
  })
}

export interface RecordedAPI {
  /** L'API a donner au plugin. */
  api: PluginAPI
  /** Ce qu'il a enregistre jusqu'ici. */
  registrations: PluginRegistrations
}

export function recordRegistrations(api: PluginAPI): RecordedAPI {
  const r = emptyRegistrations()
  // Registre a surveiller -> sa methode d'enregistrement et ce qu'on en note.
  const watchers: Partial<Record<keyof PluginAPI, [string, Note]>> = {
    files: ['register', ([spec]) => { if (spec && typeof spec === 'object') r.fileTypes.push(spec as PluginRegistrations['fileTypes'][number]) }],
    extractors: ['register', ([spec]) => {
      const exts = (spec as { extensions?: unknown })?.extensions
      if (Array.isArray(exts)) r.extractors.push(...exts.filter((e): e is string => typeof e === 'string'))
    }],
    index: ['registerFactory', ([factory]) => {
      try {
        const ns = (factory as () => { namespace?: unknown })()?.namespace
        if (typeof ns === 'string') r.indexes.push(ns)
      } catch { /* fabrique qui a besoin d'un vault : namespace inconnu */ r.indexes.push('?') }
    }],
    agents: ['registerPreset', () => { r.agents++ }],
    ai: ['registerProvider', () => { r.aiProviders++ }],
    review: ['registerProposalType', ([spec]) => {
      const type = (spec as { type?: unknown })?.type
      if (typeof type === 'string') r.proposalTypes.push(type)
    }],
    views: ['register', () => { r.views++ }],
    blocks: ['register', () => { r.blocks++ }],
    commands: ['register', () => { r.commands++ }],
  }
  // Lu a chaque acces : certaines parties de l'API (revision, IA, requetes)
  // arrivent apres le chargement du plugin, a l'ouverture d'un vault.
  const cache = new WeakMap<object, object>()
  const proxied = new Proxy(api, {
    get(t, k) {
      const v = Reflect.get(t, k, t) as unknown
      const w = typeof k === 'string' ? watchers[k as keyof PluginAPI] : undefined
      if (!w || !v || typeof v !== 'object') return v
      let out = cache.get(v)
      if (!out) { out = watch(v, w[0], w[1])!; cache.set(v, out) }
      return out
    },
  })
  return { api: proxied, registrations: r }
}
