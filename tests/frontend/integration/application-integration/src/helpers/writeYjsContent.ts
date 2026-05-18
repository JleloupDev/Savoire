// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import * as Y from 'yjs'
import { HubConnectionBuilder } from '@microsoft/signalr'
import { SERVER_URL } from './makeAppRoot'

/**
 * Writes content to a document by pushing a Yjs op directly to /hubs/sync.
 * This mirrors exactly what the real editor does — no REST shortcut.
 * The text is written into the 'codemirror' Y.Text field, matching
 * what CrdtDocumentFetcher reads.
 */
export async function writeYjsContent(
  vaultId: string,
  docId: string,
  content: string,
  getToken: () => string,
  userId: string,
): Promise<void> {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('codemirror')

  const updates: Uint8Array[] = []
  ydoc.on('update', (u: Uint8Array) => updates.push(u))
  ytext.insert(0, content)

  const conn = new HubConnectionBuilder()
    .withUrl(`${SERVER_URL}/hubs/sync?userId=${encodeURIComponent(userId)}`, {
      accessTokenFactory: () => getToken(),
    })
    .build()

  await conn.start()
  await conn.invoke('JoinDocument', vaultId, docId)

  for (const update of updates) {
    const opBase64 = Buffer.from(update).toString('base64')
    await conn.invoke('PushOperation', vaultId, docId, userId, opBase64)
  }

  await conn.stop()
}
