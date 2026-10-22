// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Excalidraw charge ses morceaux (polices, langues, code differe) depuis un
// CDN (unpkg) par defaut. L'appli de bureau l'interdit (CSP) et doit marcher
// hors ligne : on les sert nous-memes, depuis /excalidraw-assets/ (copies
// par vite.config.ts). A importer avant tout code d'Excalidraw.
declare global {
  interface Window { EXCALIDRAW_ASSET_PATH?: string }
}

window.EXCALIDRAW_ASSET_PATH = '/'

export {}
