// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
/**
 * Operations de l'arborescence sur le vault : deplacer un dossier, une note
 * de dossier, supprimer un dossier avec son contenu, creer une sous-page.
 *
 * Tout passe par VaultAPI (renameFile, createFolder, deleteFolder...). Il n'y
 * a pas de renommage de dossier dans l'API : on renomme chaque document du
 * dossier, ce qui marche dans les deux profils de synchro.
 */
import type { VaultAPI, FileTypeSpec } from '@savoire/plugin-api'
import { extensionOf, folderOfNote, isInside, parentOf, rebasePath, uniqueChildPath } from './folderNotes'

export interface FolderContent {
  /** Fichiers, a toute profondeur. */
  files: string[]
  /** Sous-dossiers (avec `/` final), a toute profondeur, dossier racine compris. */
  folders: string[]
}

/** Parcourt un dossier en profondeur avec VaultAPI.list. */
export async function collectFolder(vault: VaultAPI, folderPath: string): Promise<FolderContent> {
  const files: string[] = []
  const folders: string[] = [folderPath]
  const queue = [folderPath]
  while (queue.length > 0) {
    const dir = queue.shift()!
    for (const entry of await vault.list(dir)) {
      if (entry.endsWith('/')) { folders.push(entry); queue.push(entry) }
      else files.push(entry)
    }
  }
  return { files, folders }
}

function requireId(vault: VaultAPI, path: string): string {
  const id = vault.resolveDocumentId(path)
  if (!id) throw new Error(`Document not found: ${path}`)
  return id
}

/**
 * Deplace (ou renomme) un dossier : chaque document change de prefixe. Les
 * dossiers vides sont recrees a la nouvelle place ; l'ancienne entree de
 * dossier est retiree.
 */
export async function moveFolder(vault: VaultAPI, from: string, to: string): Promise<void> {
  if (from === to) return
  if (isInside(to, from)) throw new Error('Impossible de deplacer un dossier dans lui-meme.')
  if (!vault.renameFile) throw new Error('Renommage indisponible.')
  const { files, folders } = await collectFolder(vault, from)
  // Verifie tout avant de toucher a quoi que ce soit.
  for (const file of files) {
    if (vault.resolveDocumentId(rebasePath(file, from, to))) {
      throw new Error(`Un fichier existe deja : ${rebasePath(file, from, to)}`)
    }
  }
  for (const file of files) {
    await vault.renameFile(requireId(vault, file), rebasePath(file, from, to))
  }
  // Un dossier sans document dessous n'existe que par son entree : on la recree.
  for (const folder of folders) {
    const hasFile = files.some(f => f.startsWith(folder))
    if (!hasFile) await vault.createFolder?.(rebasePath(folder, from, to))
  }
  await vault.deleteFolder?.(from)
}

/**
 * Deplace (ou renomme) une note et son dossier ensemble. Si le dossier
 * n'existe pas, seul le fichier bouge.
 */
export async function moveNote(vault: VaultAPI, filePath: string, newFilePath: string): Promise<void> {
  if (filePath === newFilePath) return
  if (!vault.renameFile) throw new Error('Renommage indisponible.')
  if (vault.resolveDocumentId(newFilePath)) {
    throw new Error('Un fichier avec ce nom existe deja.')
  }
  const oldFolder = folderOfNote(filePath)
  const newFolder = folderOfNote(newFilePath)
  if (newFolder && oldFolder && isInside(newFilePath, oldFolder)) {
    throw new Error('Impossible de ranger une note dans son propre dossier.')
  }
  const hasFolder = oldFolder !== '' && (await vault.list(parentOf(filePath))).includes(oldFolder)
  const id = requireId(vault, filePath)
  // Le dossier d'abord : moveFolder verifie les conflits avant tout changement.
  if (hasFolder && newFolder) await moveFolder(vault, oldFolder, newFolder)
  await vault.renameFile(id, newFilePath)
}

/** Met un dossier et tous ses documents a la corbeille (VaultAPI.deleteFile). */
export async function deleteFolderDeep(vault: VaultAPI, folderPath: string): Promise<void> {
  const { files } = await collectFolder(vault, folderPath)
  for (const file of files) {
    const id = vault.resolveDocumentId(file)
    if (id) await vault.deleteFile?.(id)
  }
  await vault.deleteFolder?.(folderPath)
}

/** Cree un document et y ecrit le contenu initial de son type, s'il en a un. */
export async function createDocument(vault: VaultAPI, path: string, fileTypes: readonly FileTypeSpec[]): Promise<void> {
  await vault.createFile?.(path)
  const ext = extensionOf(path)
  const spec = fileTypes.find(s => s.extension === ext && s.creatable !== false)
  if (!spec) return
  // Un type 'crdt' commence vide : son etat n'existe que par ses operations,
  // et une ecriture en bloc ne passerait ni par les pairs ni par la synchro.
  // C'est sa vue qui pose la structure de depart, a la premiere frappe.
  if (spec.collaborationMode === 'crdt') return
  const initialContent = await spec.create()
  if (!initialContent) return
  const docId = vault.resolveDocumentId(path)
  if (docId) await vault.write(docId, initialContent)
}

/**
 * Cree une sous-page d'un fichier : `Projet/Sans titre.<meme extension>`.
 * Le dossier apparait avec son premier document. Rend le chemin cree.
 */
export async function createSubPage(vault: VaultAPI, filePath: string, fileTypes: readonly FileTypeSpec[]): Promise<string> {
  const folder = folderOfNote(filePath)
  if (!folder) throw new Error('Ce fichier n\'a pas d\'extension : pas de sous-page possible.')
  const existing = new Set(await vault.list(folder))
  const path = uniqueChildPath(folder, extensionOf(filePath), existing)
  await createDocument(vault, path, fileTypes)
  return path
}
