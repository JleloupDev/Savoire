// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les bibliotheques communes que l'application fournit aux plugins
// (plugin-api/libraries.ts) : SA copie de React et de CodeMirror. Chacune
// n'est chargee que si un plugin la demande.
import { SharedLibraryRegistry } from '@savoire/plugin-runtime'
import { codeMirrorModules } from '@savoire/editor-core'

/** Module ES de React (CommonJS a l'origine) : l'objet entier, comme le donnerait require(). */
const cjs = <T>(mod: { default?: T } & T): T => (mod.default ?? mod) as T

export const sharedLibraries = new SharedLibraryRegistry()
  .provide('@savoire/plugin-api', () => import('@savoire/plugin-api'))
  .provide('react', async () => cjs(await import('react')))
  .provide('react/jsx-runtime', () => import('react/jsx-runtime'))
  .provide('react-dom', async () => cjs(await import('react-dom')))
  .provide('react-dom/client', () => import('react-dom/client'))
  .provide('@codemirror/state', codeMirrorModules['@codemirror/state'])
  .provide('@codemirror/view', codeMirrorModules['@codemirror/view'])
  .provide('@codemirror/language', codeMirrorModules['@codemirror/language'])
  .provide('@codemirror/commands', codeMirrorModules['@codemirror/commands'])
