// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Lignes-pages : les notes de la source d'une base. Leurs valeurs vivent dans
// leur frontmatter ; une cellule modifiee ecrit le frontmatter de la note par
// VaultAPI.editText, comme une frappe (synchro CRDT de la note, qui fusionne
// avec une edition en cours dans un editeur ouvert).
//
// Convention des notes de dossier (plugin-filetree, folderNotes.ts) : une
// base `Projets/Taches.base` et le dossier frere `Projets/Taches/` forment un
// seul noeud ; les nouvelles lignes-pages y sont creees.
import { removeFrontmatterKey, setFrontmatterValue } from '@savoire/plugin-api'
import type { PropertyValue, VaultAPI } from '@savoire/plugin-api'

/** Ce dont les lignes-pages ont besoin du vault. */
export type NotesVault = Pick<VaultAPI, 'resolveDocumentId' | 'createFile' | 'renameFile' | 'editText'>

/** Dossier d'une base : `A/Taches.base` -> `A/Taches` (sans `/` final). */
export function folderOfBase(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return (slash >= 0 ? path.slice(0, slash + 1) : '') + stem
}

/** Nom de fichier sans caracteres interdits. */
export function safeFileName(title: string): string {
  const clean = title.replace(/[\\/:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean || 'Sans titre'
}

/** Chemin libre `Dossier/Nom.md`, puis `Nom 2.md`... */
export function uniqueNotePath(folder: string, title: string, exists: (path: string) => boolean): string {
  const base = safeFileName(title)
  const prefix = folder ? folder.replace(/\/+$/, '') + '/' : ''
  let candidate = `${prefix}${base}.md`
  for (let n = 2; exists(candidate); n++) candidate = `${prefix}${base} ${n}.md`
  return candidate
}

function requireEditText(vault: NotesVault): NonNullable<VaultAPI['editText']> {
  const editText = vault.editText
  if (!editText) throw new Error('Ce profil ne sait pas modifier une note hors de son éditeur.')
  return editText
}

/** Ecrit une propriete dans le frontmatter d'une note. undefined : la retire. */
export async function writeNoteProperty(vault: NotesVault, docId: string, key: string, value: PropertyValue | undefined): Promise<void> {
  const editText = requireEditText(vault)
  await editText(docId, md => value === undefined ? removeFrontmatterKey(md, key) : setFrontmatterValue(md, key, value))
}

/**
 * Cree une ligne-page : une note dans le dossier de la base, avec ses
 * valeurs en frontmatter. Rend son chemin et son id.
 */
export async function createPageRow(
  vault: NotesVault,
  folder: string,
  title: string,
  values: Record<string, PropertyValue> = {},
): Promise<{ path: string; id: string }> {
  if (!vault.createFile) throw new Error('Ce vault ne permet pas de créer de note.')
  const path = uniqueNotePath(folder, title, p => !!vault.resolveDocumentId(p))
  await vault.createFile(path)
  const id = vault.resolveDocumentId(path)
  if (!id) throw new Error(`Note introuvable après sa création : ${path}`)
  const entries = Object.entries(values).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
  if (entries.length > 0) {
    const editText = requireEditText(vault)
    await editText(id, md => entries.reduce((acc, [k, v]) => setFrontmatterValue(acc, k, v), md))
  }
  return { path, id }
}

/** Renomme la note d'une ligne-page (son titre), dans le meme dossier. */
export async function renamePageRow(vault: NotesVault, docId: string, path: string, title: string): Promise<string> {
  if (!vault.renameFile) throw new Error('Ce vault ne permet pas de renommer une note.')
  const slash = path.lastIndexOf('/')
  const folder = slash >= 0 ? path.slice(0, slash) : ''
  const ext = path.slice(path.lastIndexOf('.'))
  const next = uniqueNotePath(folder, title, p => p !== path && !!vault.resolveDocumentId(p)).replace(/\.md$/, ext)
  if (next !== path) await vault.renameFile(docId, next)
  return next
}
