// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'application tourne-t-elle dans la fenetre Tauri (version bureau) ?
//
// Tauri 2 pose deux marques dans la page avant tout script : `isTauri`
// (vrai) et `__TAURI_INTERNALS__` (le pont IPC, avec `invoke`). Tauri 1
// posait `__TAURI__`/`__TAURI_IPC__` : ignores ici, la coquille bureau est
// en Tauri 2. On exige le pont IPC, pas seulement le drapeau : sans lui,
// aucune commande ne passerait.
//
// Volontairement sans @tauri-apps/api : ce fichier entre dans le bundle web.

export function isTauriRuntime(scope: unknown = globalThis): boolean {
  if (!scope || typeof scope !== 'object') return false
  const g = scope as { isTauri?: unknown; __TAURI_INTERNALS__?: { invoke?: unknown } }
  return g.isTauri === true && typeof g.__TAURI_INTERNALS__?.invoke === 'function'
}
