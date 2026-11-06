// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Apres un deplacement ou un renommage (image, note, dossier) : les liens
// des notes suivent, comme dans Obsidian (rewriteMovedLinks, plugin-api).
//
// Les notes a examiner viennent de l'index du vault (links.citing : les
// notes dont un lien vise un fichier de ce nom) ; sans index, toutes les
// notes Markdown sont lues. Seules celles dont un lien change sont modifiees
// (VaultAPI.editText : comme une frappe, fusionnee avec une edition en cours).
import type { IIndexerAPI, VaultAPI } from '@savoire/plugin-api'
import { createLinkResolver, linkTargetFor, rewriteMovedLinks } from '@savoire/plugin-api'

/** Lectures de notes en parallele. */
const CONCURRENCY = 8

export interface Move { from: string; to: string }

async function allFiles(vault: Pick<VaultAPI, 'list'>): Promise<string[]> {
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

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase()
}

/** Noms qu'un lien vers ce fichier peut porter, en minuscules (cles de l'index). */
function linkNames(path: string): string[] {
  const name = nameOf(path)
  return name.endsWith('.md') ? [name, name.slice(0, -3)] : [name]
}

/**
 * Notes qui citent ces fichiers, d'apres l'index ; null sans index (ou en
 * panne) : il faudra tout lire. Les chemins rendus sont ceux d'apres.
 */
async function citingNotes(indexer: IIndexerAPI | undefined, moves: readonly Move[]): Promise<string[] | null> {
  if (!indexer?.available() || typeof indexer.links.citing !== 'function') return null
  try {
    const names = [...new Set(moves.flatMap(m => linkNames(m.from)))]
    const forward = new Map(moves.map(m => [m.from, m.to]))
    const { items } = await indexer.links.citing({ names })
    const paths = items.map(i => forward.get(i.path) ?? i.path)
    // L'index a pu deja suivre le deplacement : une note deplacee est aussi a voir.
    for (const m of moves) if (m.to.toLowerCase().endsWith('.md')) paths.push(m.to)
    return [...new Set(paths)]
  } catch {
    return null
  }
}

/** Les mots qu'un lien vers ce fichier contient forcement : son nom, sans .md pour une note. */
function needleOf(path: string): string {
  return nameOf(path).replace(/\.md$/, '')
}

/**
 * Recrit les liens des notes vers les fichiers deplaces. Rend le nombre de
 * notes modifiees. A appeler APRES les deplacements.
 */
export async function relinkAfterMoves(
  vault: Pick<VaultAPI, 'list' | 'readDocumentByPath' | 'resolveDocumentId' | 'editText'>,
  moves: readonly Move[],
  indexer?: IIndexerAPI,
): Promise<number> {
  const real = moves.filter(m => m.from !== m.to)
  if (!real.length || typeof vault.editText !== 'function') return 0
  const after = await allFiles(vault)
  const back = new Map(real.map(m => [m.to, m.from]))
  const beforePaths = after.map(p => back.get(p) ?? p)
  const ctx = {
    moves: new Map(real.map(m => [m.from, m.to])),
    before: createLinkResolver(beforePaths),
    after: createLinkResolver(after),
    targetFor: (path: string) => linkTargetFor(path, after),
  }
  // Un nom en minuscules, avec et sans espaces encodees (liens Markdown).
  const needles = [...new Set(real.flatMap(m => {
    const n = needleOf(m.from)
    return [n, encodeURI(n).toLowerCase()]
  }))]
  const fromIndex = await citingNotes(indexer, real)
  const present = new Set(after)
  const notes = (fromIndex ?? after).filter(p => p.toLowerCase().endsWith('.md') && present.has(p))
  let changed = 0
  let next = 0
  const work = async () => {
    while (next < notes.length) {
      const path = notes[next++]
      let text: string
      try { text = await vault.readDocumentByPath(path) } catch { continue }
      const lower = text.toLowerCase()
      if (!needles.some(n => lower.includes(n))) continue
      const oldSource = back.get(path) ?? path
      if (rewriteMovedLinks(text, ctx, oldSource, path) === null) continue
      const id = vault.resolveDocumentId(path)
      if (!id) continue
      // Sur le texte du moment (une frappe a pu arriver entre-temps).
      const ok = await vault.editText!(id, current => rewriteMovedLinks(current, ctx, oldSource, path) ?? current)
      if (ok) changed++
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, notes.length) }, work))
  return changed
}
