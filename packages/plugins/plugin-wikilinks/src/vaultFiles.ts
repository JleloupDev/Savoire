// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
import type { VaultAPI } from '@savoire/plugin-api'

/**
 * Tous les fichiers du vault, sous-dossiers compris (vault.list ne donne
 * qu'un niveau). Un lien par nom vise une note de n'importe quel dossier.
 */
export async function allFilePaths(vault: Pick<VaultAPI, 'list'>): Promise<string[]> {
  const files: string[] = []
  const queue = ['']
  while (queue.length) {
    const dir = queue.shift()!
    for (const entry of await vault.list(dir || undefined)) {
      if (entry.endsWith('/')) { if (entry !== dir) queue.push(entry) }
      else files.push(entry)
    }
  }
  return files
}
