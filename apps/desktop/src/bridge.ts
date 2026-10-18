// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le pont vers le programme Rust (src-tauri). Deux fonctions seulement :
// appeler une commande, ecouter un evenement. Injecte partout, pour que le
// systeme de fichiers et l'hote bureau se testent sans Tauri.

export interface InvokeOptions {
  headers?: Record<string, string>
}

export interface TauriBridge {
  invoke<T>(cmd: string, args?: Record<string, unknown> | Uint8Array, options?: InvokeOptions): Promise<T>
  /** Rend une fonction d'arret (asynchrone cote Tauri, d'ou la promesse). */
  listen<T>(event: string, cb: (payload: T) => void): Promise<() => void>
}

/** Le vrai pont, sur @tauri-apps/api (charge a la demande). */
export async function loadTauriBridge(): Promise<TauriBridge> {
  const core = await import('@tauri-apps/api/core')
  const events = await import('@tauri-apps/api/event')
  return {
    invoke: (cmd, args, options) => core.invoke(cmd, args, options?.headers ? { headers: options.headers } : undefined),
    listen: (event, cb) => events.listen(event, e => cb(e.payload as never)),
  }
}
