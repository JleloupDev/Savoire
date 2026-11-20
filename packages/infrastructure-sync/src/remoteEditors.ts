// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Qui vient de modifier une note a distance : le serveur joint l'auteur a
// chaque operation relayee (SyncHub, ReceiveOperation). L'historique des
// versions s'en sert pour attribuer une modification a la bonne personne,
// notamment a un invite (lien de partage), qui ne tient pas d'historique.

export interface RemoteEditor {
  id: string
  name: string
  /** Lien de partage ou jeton de vue, sans compte. */
  guest: boolean
  /** Modification faite par un agent IA pour cette personne (id et nom de l'agent). */
  agentId?: string
  agentName?: string
}

const recent = new Map<string, Map<string, RemoteEditor>>()

/** Note l'auteur d'une operation recue (appele par la passerelle de synchro). */
export function noteRemoteEditor(docId: string, raw: unknown): void {
  const a = raw as { id?: unknown; name?: unknown; guest?: unknown; agentId?: unknown; agentName?: unknown } | null | undefined
  if (!a || typeof a.id !== 'string' || !a.id) return
  const editor: RemoteEditor = {
    id: a.id,
    name: typeof a.name === 'string' && a.name ? a.name.slice(0, 100) : 'Invité',
    guest: a.guest === true,
  }
  if (typeof a.agentId === 'string' && a.agentId && typeof a.agentName === 'string' && a.agentName) {
    editor.agentId = a.agentId
    editor.agentName = a.agentName.slice(0, 100)
    // Une cle a part : la personne et son agent ne s'ecrasent pas.
    editor.id = `agent:${a.agentId}:${a.id}`
    editor.name = typeof a.name === 'string' && a.name ? a.name.slice(0, 100) : ''
  }
  let byId = recent.get(docId)
  if (!byId) { byId = new Map(); recent.set(docId, byId) }
  byId.set(editor.id, editor)
}

/** Les auteurs distants d'une note depuis le dernier appel (puis oublies). */
export function takeRemoteEditors(docId: string): RemoteEditor[] {
  const byId = recent.get(docId)
  recent.delete(docId)
  return byId ? [...byId.values()] : []
}
