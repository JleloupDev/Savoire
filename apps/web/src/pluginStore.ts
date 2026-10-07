// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Store officiel : les plugins disponibles a l'installation. Ecrit en dur pour
// l'instant ; demain, un index publie par un store externe.
//
// Comme l'index d'un vrai store, chaque entree decrit le plugin SANS charger
// son code : le code n'est importe qu'a l'installation. Le manifeste du
// plugin reste la reference, un test verifie que l'entree le recopie fidelement.
//
// Les plugins du coeur (explorateur, liens, tables...) ne sont pas ici : ils
// sont preinstalles, charges au demarrage par usePluginBootstrap.
import type { PluginManifest, VaultPlugin } from '@savoire/plugin-api'

export interface StoreEntry {
  manifest: PluginManifest
  /** Extensions de fichier que le plugin ouvre : pour proposer de l'installer. */
  extensions: string[]
  load: () => Promise<VaultPlugin>
}

export const STORE_CATALOG: StoreEntry[] = [
  {
    manifest: {
      id: 'plugin-wtf',
      name: 'WTF (test)',
      version: '0.0.1',
      description: 'Plugin de test : des fichiers .wtf qui sont du simple Markdown',
      scope: 'vault',
      permissions: ['ui:editor'],
      defaultActive: true,
    },
    extensions: ['wtf'],
    load: () => import('@savoire/plugin-wtf').then(m => m.default),
  },
]
