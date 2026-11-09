// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// « Partager le module » demande par le plugin Modules (api.workspace.shareModule) :
// l'application ouvre sa fenetre de partage.
const listeners = new Set<(path: string) => void>()

export function requestModuleShare(path: string): void {
  for (const cb of listeners) cb(path)
}

export function onModuleShareRequest(cb: (path: string) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
