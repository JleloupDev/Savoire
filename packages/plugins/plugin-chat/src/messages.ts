// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les messages d'une discussion, dans la carte partagee du document. Chaque
// message est une cle a lui : deux personnes qui ecrivent en meme temps ne
// s'ecrasent jamais, et tous les membres convergent sur la meme liste.
import type { ISharedMap, ISharedTree, ITreeMap } from '@savoire/plugin-api'

export interface ChatMessage {
  id: string
  author: { id: string; name: string }
  text: string
  /** Date ISO. */
  at: string
}

export function readMessages(map: ISharedMap): ChatMessage[] {
  return map.getAll()
    .map(e => e.value as ChatMessage)
    .filter(m => typeof m?.text === 'string' && typeof m.at === 'string')
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
}

export function postMessage(
  map: ISharedMap,
  author: ChatMessage['author'],
  text: string,
  now: Date = new Date(),
): ChatMessage | null {
  const clean = text.trim()
  if (!clean) return null
  const message: ChatMessage = { id: crypto.randomUUID(), author, text: clean, at: now.toISOString() }
  map.set(message.id, message)
  return message
}

// ── Dans le CRDT du document ────────────────────────────────────────────────
//
// Les messages vivent dans l'arbre partage du document lui-meme (ctx.tree) :
// ils suivent le document (partage, suppression, copie) au lieu de vivre a
// cote. Chaque message est une cle de la racine (`msg/<id>`) : deux membres
// qui ecrivent en meme temps creent deux cles, jamais la meme. Pas de liste
// commune a creer au premier message : deux pairs qui la creeraient en meme
// temps s'ecraseraient.

const PREFIX = 'msg/'

function readTreeMessage(value: unknown): ChatMessage | null {
  const node = value as ITreeMap | undefined
  if (!node || node.kind !== 'map') return null
  const json = node.toJSON() as Record<string, unknown>
  if (typeof json.id !== 'string' || typeof json.text !== 'string' || typeof json.at !== 'string') return null
  return {
    id: json.id,
    text: json.text,
    at: json.at,
    author: { id: String(json.authorId ?? ''), name: String(json.authorName ?? json.authorId ?? '') },
  }
}

/**
 * Les messages de l'arbre du document, vus comme une carte partagee : la vue
 * et les fonctions ci-dessus marchent sans changement.
 */
export function treeMessageMap(tree: ISharedTree): ISharedMap {
  return {
    set(key, value) {
      const m = value as ChatMessage
      tree.root.set(PREFIX + key, {
        kind: 'map',
        entries: { id: m.id, text: m.text, at: m.at, authorId: m.author.id, authorName: m.author.name },
      })
    },
    delete(key) {
      tree.root.delete(PREFIX + key)
    },
    getAll() {
      return tree.root.keys()
        .filter(k => k.startsWith(PREFIX))
        .map(k => ({ id: k.slice(PREFIX.length), value: readTreeMessage(tree.root.get(k)) }))
        .filter((e): e is { id: string; value: ChatMessage } => e.value !== null)
    },
    onChange(cb) {
      return tree.onChange(() => cb([]))
    },
  }
}

/**
 * Lecture de deux cartes a la fois : les messages du document, et ceux
 * ecrits avant (carte du vault, a cote du document). On ecrit toujours dans
 * la premiere ; les anciens restent lisibles.
 */
export function mergedMessageMap(primary: ISharedMap, legacy: ISharedMap): ISharedMap {
  return {
    set: (key, value) => primary.set(key, value),
    delete: (key) => { primary.delete(key); legacy.delete(key) },
    getAll: () => {
      const seen = new Set(primary.getAll().map(e => e.id))
      return [...primary.getAll(), ...legacy.getAll().filter(e => !seen.has(e.id))]
    },
    onChange(cb) {
      const a = primary.onChange(cb)
      const b = legacy.onChange(cb)
      return () => { a(); b() }
    },
  }
}
