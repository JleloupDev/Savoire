// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Notes de bas de page, ecrites comme dans Obsidian et Pandoc :
//
//   Une phrase avec une note[^1].
//
//   [^1]: Le texte de la note.
//
// L'appel devient un petit numero en exposant ; la definition, une ligne de
// note (numero, puis texte). Ici, seulement le texte : rien qui depende de
// l'editeur, pour servir aussi a l'export et a la page publiee.

/** Un appel de note : [^1], [^source]. */
export const REF_RE = /\[\^([^\]\s^]+)\](?!:)/g
/** Une definition en debut de ligne : [^1]: texte. */
export const DEF_RE = /^\[\^([^\]\s^]+)\]:[ \t]?/

const FENCE_RE = /^\s*(```|~~~)/

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Les appels d'une ligne, hors du code entre ` `. */
function refsInLine(line: string): string {
  // Les morceaux impairs sont du code en ligne : on n'y touche pas.
  return line.split(/(`+[^`]*`+)/).map((part, i) =>
    i % 2 === 1 ? part : part.replace(REF_RE, (_m, id: string) => {
      const safe = escapeAttr(id)
      return `<sup class="plume-fn-ref" data-fn="${safe}">${safe}</sup>`
    }),
  ).join('')
}

/** Le Markdown, appels et definitions de notes remplaces par leur HTML. */
export function renderFootnotes(source: string): string {
  if (!source.includes('[^')) return source
  let fence: string | null = null
  return source.split('\n').map(line => {
    const f = FENCE_RE.exec(line)
    if (f) {
      if (fence === null) fence = f[1]
      else if (f[1] === fence) fence = null
      return line
    }
    if (fence !== null) return line
    const def = DEF_RE.exec(line)
    if (def) {
      const safe = escapeAttr(def[1])
      return `<sup class="plume-fn-def" data-fn="${safe}">${safe}</sup> ${refsInLine(line.slice(def[0].length))}`
    }
    return refsInLine(line)
  }).join('\n')
}

/** Le texte de la definition de la note `id`, ou null. */
export function footnoteText(doc: string, id: string): string | null {
  for (const line of doc.split('\n')) {
    const def = DEF_RE.exec(line)
    if (def && def[1] === id) return line.slice(def[0].length).trim()
  }
  return null
}

/** Ou commence le texte de la definition de `id` dans `doc` (pour y aller), ou -1. */
export function definitionPos(doc: string, id: string): number {
  let at = 0
  for (const line of doc.split('\n')) {
    const def = DEF_RE.exec(line)
    if (def && def[1] === id) return at + def[0].length
    at += line.length + 1
  }
  return -1
}

/** Juste apres le premier appel de `id` (pour revenir de la note), ou -1. */
export function firstRefPos(doc: string, id: string): number {
  const re = new RegExp(REF_RE.source, 'g')
  for (let m = re.exec(doc); m; m = re.exec(doc)) {
    const lineStart = doc.lastIndexOf('\n', m.index) + 1
    // Une definition n'est pas un appel.
    if (m[1] === id && !(m.index === lineStart && doc[m.index + m[0].length] === ':')) return m.index + m[0].length
  }
  return -1
}

/** Le numero de la prochaine note : un de plus que le plus grand numero deja pris. */
export function nextFootnoteLabel(doc: string): string {
  let max = 0
  for (const m of doc.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(m[1]))
  return String(max + 1)
}

/**
 * Inserer une note au curseur `pos` : l'appel [^n] la, la definition
 * « [^n]: » en fin de note (apres une ligne vide si besoin). Rend les
 * changements et ou mettre le curseur (dans la definition).
 */
export function insertFootnote(doc: string, pos: number): { changes: { from: number; to: number; insert: string }[]; cursor: number; label: string } {
  const label = nextFootnoteLabel(doc)
  const ref = `[^${label}]`
  const lines = doc.replace(/\n+$/, '').split('\n')
  const last = lines[lines.length - 1] ?? ''
  // Les definitions se suivent ; sinon une ligne vide les separe du texte.
  const sep = doc.length === 0 ? '' : DEF_RE.test(last) ? (doc.endsWith('\n') ? '' : '\n') : (doc.endsWith('\n\n') ? '' : doc.endsWith('\n') ? '\n' : '\n\n')
  const def = `${sep}[^${label}]: `
  return {
    changes: [{ from: pos, to: pos, insert: ref }, { from: doc.length, to: doc.length, insert: def }],
    cursor: doc.length + ref.length + def.length,
    label,
  }
}
