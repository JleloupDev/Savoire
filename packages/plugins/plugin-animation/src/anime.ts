// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// anime.js v4 (licence MIT, Julian Garnier), en texte : il est ecrit dans le
// document de chaque animation, qui n'a pas le droit de telecharger quoi que
// ce soit (CSP). Charge a la premiere animation affichee, une seule fois.
//
// Le paquet n'exporte que ses modules ESM ; le fichier UMD (une variable
// globale `anime`) est lu par son chemin dans node_modules.
/// <reference path="./raw.d.ts" />
let loading: Promise<string> | null = null

export function animeSource(): Promise<string> {
  loading ??= import('../node_modules/animejs/dist/bundles/anime.umd.min.js?raw').then(m => m.default)
  return loading
}

/** Pour les tests : un texte a la place du vrai fichier. */
export function setAnimeSource(source: string | null): void {
  loading = source === null ? null : Promise.resolve(source)
}
