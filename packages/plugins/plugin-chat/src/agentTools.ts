// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Outils d'agent des discussions (ADR-033) : lire une discussion (.chat),
// y poster un message. Poster est une action « comment » ; le message est
// signe « Agent (IA), pour Jean ».
import type { PluginAPI, PluginTool } from '@savoire/plugin-api'
import { noteRef } from '@savoire/plugin-api'
import { postMessage, readMessages, treeMessageMap } from './messages'

async function withMessages<T>(api: PluginAPI, docId: string, use: (map: ReturnType<typeof treeMessageMap>) => T): Promise<T> {
  if (typeof api.vault.openTree !== 'function') throw new Error('Discussions indisponibles sans synchronisation du vault.')
  const tree = await api.vault.openTree(docId)
  try {
    return use(treeMessageMap(tree))
  } finally {
    // Laisser partir le message avant de fermer.
    setTimeout(() => api.vault.closeTree?.(docId), 3000)
  }
}

function chatRef(api: PluginAPI, ref: unknown): { id: string; path: string } {
  const r = noteRef(api, typeof ref === 'string' && !/\.chat$/i.test(ref) && !ref.includes('.') ? `${ref}.chat` : ref)
  if (!r.path.toLowerCase().endsWith('.chat')) throw new Error('Une discussion est un fichier .chat.')
  return r
}

export function chatAgentTools(api: PluginAPI): PluginTool[] {
  return [
    {
      spec: {
        name: 'read_chat', title: 'Lire une discussion', action: 'read',
        description: 'Les derniers messages d’une discussion (fichier .chat), avec leur auteur et leur date.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Discussion (.chat).' }, limit: { type: 'integer', description: 'Messages (1 à 200, 50 par défaut).' } }, required: ['path'], additionalProperties: false },
      },
      async run(args) {
        const chat = chatRef(api, args.path)
        const limit = Math.max(1, Math.min(200, typeof args.limit === 'number' ? Math.floor(args.limit) : 50))
        const messages = await withMessages(api, chat.id, map => readMessages(map).slice(-limit))
        return {
          text: messages.length ? messages.map(m => `[${m.at}] ${m.author.name} : ${m.text}`).join('\n') : 'Aucun message.',
          sources: [{ docId: chat.id, path: chat.path }],
        }
      },
    },
    {
      spec: {
        name: 'post_chat', title: 'Écrire dans une discussion', action: 'comment',
        description: 'Poste un message dans une discussion (fichier .chat), au nom de l’agent.',
        inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Discussion (.chat).' }, text: { type: 'string', description: 'Le message.' } }, required: ['path', 'text'], additionalProperties: false },
      },
      async run(args, ctx) {
        const chat = chatRef(api, args.path)
        const text = typeof args.text === 'string' ? args.text : ''
        const author = { id: ctx.actor.onBehalfOf.userId, name: `${ctx.actor.agentName} (IA), pour ${ctx.actor.onBehalfOf.displayName}` }
        const posted = await withMessages(api, chat.id, map => postMessage(map, author, text))
        if (!posted) throw new Error('Le message est vide.')
        return { text: `Message posté dans ${chat.path}.`, sources: [{ docId: chat.id, path: chat.path }] }
      },
    },
  ]
}
