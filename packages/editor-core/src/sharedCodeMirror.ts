// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La copie de CodeMirror de l'editeur, pour les bibliotheques communes des
// plugins (plugin-api/libraries.ts) : un plugin externe utilise la meme, pas
// la sienne (deux CodeMirror dans une page ne partagent pas leurs etats).
export const codeMirrorModules = {
  '@codemirror/state': () => import('@codemirror/state'),
  '@codemirror/view': () => import('@codemirror/view'),
  '@codemirror/language': () => import('@codemirror/language'),
  '@codemirror/commands': () => import('@codemirror/commands'),
} as const
