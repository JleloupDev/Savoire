// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les messages d'une discussion, dans la carte partagee du document. Chaque
// message est une cle a lui : deux personnes qui ecrivent en meme temps ne
// s'ecrasent jamais, et tous les membres convergent sur la meme liste.
import type { ISharedMap } from '@savoire/plugin-api'

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
