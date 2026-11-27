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

/**
 * Android : Tauri y tourne dans la WebView du systeme, qui se presente comme
 * telle. L'app y est serveur seulement (pas de dossier de vault).
 */
export function isAndroidRuntime(userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /\bAndroid\b/.test(userAgent)
}

/**
 * Adresse du cadre des boards, servi par la coquille bureau (protocole
 * savoire-board, avec sa propre CSP). Windows sert les protocoles maison en
 * http://<nom>.localhost, Linux et macOS en <nom>://localhost. Null hors bureau.
 */
export function boardFrameUrl(scope: unknown = globalThis, userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string | null {
  if (!isTauriRuntime(scope) || isAndroidRuntime(userAgent)) return null
  return /\bWindows\b/.test(userAgent) ? 'http://savoire-board.localhost/' : 'savoire-board://localhost/'
}

/**
 * Cadre des boards et des plugins du store : celui du bureau, sinon la page
 * /frame.html de l'appli (sa propre CSP, voir nginx.conf.template). Une iframe
 * srcdoc heriterait de la CSP de l'appli, qui interdit le JavaScript en ligne.
 */
export function sandboxFrameUrl(scope: unknown = globalThis, userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string | null {
  const desktop = boardFrameUrl(scope, userAgent)
  if (desktop) return desktop
  const loc = (scope as { location?: { href?: string; protocol?: string } }).location
  if (!loc?.href || !/^https?:$/.test(loc.protocol ?? '')) return null
  return new URL('/frame.html', loc.href).href
}

/**
 * Lecture de pages web pour les plugins (api.network) : version bureau
 * seulement, par la commande native web_fetch_text (liste fermee de sites).
 * Undefined ailleurs : sur le web, le navigateur ne lit pas les autres sites.
 */
export function desktopNetwork(
  scope: unknown = globalThis,
  userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : '',
): { fetchText(url: string): Promise<string> } | undefined {
  if (!isTauriRuntime(scope) || isAndroidRuntime(userAgent)) return undefined
  const internals = (scope as { __TAURI_INTERNALS__: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> } }).__TAURI_INTERNALS__
  return { fetchText: async url => String(await internals.invoke('web_fetch_text', { url })) }
}

/**
 * Cadre des applications (.app) : sa propre politique, plus large que celle
 * des boards (modules blob:, workers), toujours sans reseau. Bureau : le
 * protocole savoire-board, chemin /app (board_frame.rs) ; web : la page
 * /app-frame.html (nginx.conf.template).
 */
export function sandboxAppFrameUrl(scope: unknown = globalThis, userAgent: string = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string | null {
  const desktop = boardFrameUrl(scope, userAgent)
  if (desktop) return `${desktop}app`
  const loc = (scope as { location?: { href?: string; protocol?: string } }).location
  if (!loc?.href || !/^https?:$/.test(loc.protocol ?? '')) return null
  return new URL('/app-frame.html', loc.href).href
}
