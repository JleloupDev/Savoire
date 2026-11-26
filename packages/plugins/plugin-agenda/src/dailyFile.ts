// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La note du jour dans le vault : la trouver, ou la creer depuis le modele
// « Note du jour ». Partage par la commande, les outils d'agent et la note rapide.
import { renderTemplate, type PluginAPI } from '@savoire/plugin-api'
import { dailyNotePath, dailyTemplatePath, dateOfKey } from './daily'

/** Le chemin et l'identifiant de la note du jour `key`, creee si besoin. */
export async function ensureDailyNote(api: PluginAPI, key: string, files: readonly string[]): Promise<{ path: string; id: string }> {
  const path = dailyNotePath(key, files)
  if (!files.includes(path)) {
    if (typeof api.vault.createFile !== 'function') throw new Error('Ce vault ne permet pas de créer de note.')
    const template = dailyTemplatePath(files)
    const text = template ? renderTemplate(await api.vault.readDocumentByPath(template), { title: key, date: dateOfKey(key) }) : ''
    await api.vault.createFile(path)
    const id = await documentIdOf(api, path)
    if (text && id && typeof api.vault.editText === 'function') await api.vault.editText(id, current => current || text)
    api.workspace?.notifyVaultChange?.()
  }
  const id = await documentIdOf(api, path)
  if (!id) throw new Error('La note du jour n’a pas pu être créée.')
  return { path, id }
}

/**
 * L'identifiant d'une note qui vient d'etre creee : la liste des notes de
 * l'appli peut le connaitre un instant apres (premiere note d'un vault vide,
 * avec son dossier). On l'attend un peu.
 */
async function documentIdOf(api: PluginAPI, path: string, waitMs = 5000): Promise<string | undefined> {
  const end = Date.now() + waitMs
  for (;;) {
    const id = api.vault.resolveDocumentId(path)
    if (id || Date.now() >= end) return id
    await new Promise(r => setTimeout(r, 100))
  }
}
