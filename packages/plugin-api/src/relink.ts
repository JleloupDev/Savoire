// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// LE canal des deplacements : apres un deplacement ou un renommage (note,
// image, dossier), les liens des notes qui les citent suivent, comme dans
// Obsidian (rewriteMovedLinks). Une personne (arborescence, base) ou une IA
// (outil move_note, dans l'appli ou sur le pair indexeur du serveur) passe
// par ce meme code ; seul l'acces au vault change (RelinkVault).
//
// Les notes a examiner viennent de l'index (links.citing : les notes dont un
// lien vise un fichier de ce nom) ; sans index, toutes les notes Markdown sont
// lues. Seules celles dont un lien change sont modifiees, sur leur texte du
// moment (editText : comme une frappe).
import { createLinkResolver, linkTargetFor, rewriteMovedLinks } from './links'

/** Lectures de notes en parallele. */
const CONCURRENCY = 8

export interface Move { from: string; to: string }

/** Ce que le canal lit et ecrit du vault. */
export interface RelinkVault {
  list(dir?: string): Promise<string[]>
  readDocumentByPath(path: string): Promise<string>
  resolveDocumentId(path: string): string | undefined
  editText?(documentId: string, edit: (current: string) => string): Promise<boolean>
}

/** Notes qui citent ces noms (links.citing de l'index) ; absent ou en panne : tout lire. */
export type CitingLookup = (names: string[]) => Promise<{ path: string }[]>

async function allFiles(vault: Pick<RelinkVault, 'list'>): Promise<string[]> {
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

async function citingNotes(citing: CitingLookup | undefined, moves: readonly Move[]): Promise<string[] | null> {
  if (!citing) return null
  try {
    const names = [...new Set(moves.flatMap(m => linkNames(m.from)))]
    const forward = new Map(moves.map(m => [m.from, m.to]))
    const items = await citing(names)
    const paths = items.map(i => forward.get(i.path) ?? i.path)
    // L'index a pu deja suivre le deplacement : une note deplacee est aussi a voir.
    for (const m of moves) if (m.to.toLowerCase().endsWith('.md')) paths.push(m.to)
    return [...new Set(paths)]
  } catch {
    return null
  }
}

function needleOf(path: string): string {
  return nameOf(path).replace(/\.md$/, '')
}

/**
 * Recrit les liens des notes vers les fichiers deplaces. Rend le nombre de
 * notes modifiees. A appeler APRES les deplacements.
 */
export async function relinkAfterMoves(vault: RelinkVault, moves: readonly Move[], citing?: CitingLookup): Promise<number> {
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
  const fromIndex = await citingNotes(citing, real)
  const present = new Set(after)
  const notes = (fromIndex ?? after).filter(p => p.toLowerCase().endsWith('.md') && present.has(p))
  let changed = 0
  let next = 0
  const work = async () => {
    while (next < notes.length) {
      const path = notes[next++]!
      let text: string
      try { text = await vault.readDocumentByPath(path) } catch { continue }
      const lower = text.toLowerCase()
      if (!needles.some(n => lower.includes(n))) continue
      const oldSource = back.get(path) ?? path
      if (rewriteMovedLinks(text, ctx, oldSource, path) === null) continue
      const id = vault.resolveDocumentId(path)
      if (!id) continue
      // Sur le texte du moment (une frappe a pu arriver entre-temps). Une note
      // que la personne ne peut pas modifier (ACL) reste telle quelle.
      try {
        const ok = await vault.editText!(id, current => rewriteMovedLinks(current, ctx, oldSource, path) ?? current)
        if (ok) changed++
      } catch { /* note refusee : on continue */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, notes.length) }, work))
  return changed
}

/**
 * Deplace (renomme) des documents, puis fait suivre les liens. Le canal
 * commun : VaultAPI.moveFiles dans l'appli, l'outil move_note du pair.
 */
export async function moveWithLinks(
  vault: RelinkVault & { renameFile?(documentId: string, newPath: string): Promise<void> },
  moves: readonly Move[],
  citing?: CitingLookup,
): Promise<number> {
  if (typeof vault.renameFile !== 'function') throw new Error('Déplacement indisponible.')
  const done: Move[] = []
  for (const m of moves) {
    if (m.from === m.to) continue
    const id = vault.resolveDocumentId(m.from)
    if (!id) throw new Error(`Document introuvable : ${m.from}.`)
    await vault.renameFile(id, m.to)
    done.push(m)
  }
  return relinkAfterMoves(vault, done, citing)
}
