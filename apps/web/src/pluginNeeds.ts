// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Les plugins dont un document affiche seul a besoin (lien de partage,
// module) : celui de son type de fichier, ceux qu'il declare (`plugins:`), et
// les plugins d'edition dont son texte porte une trace. Logique pure, sans
// charger aucun plugin : le catalogue (pluginStore.ts) fournit les entrees.

/** Ce qu'il faut savoir d'une entree du catalogue pour decider. */
export interface NeedEntry {
  id: string
  editorDefault?: boolean
  extensions?: string[]
  contentPatterns?: RegExp[]
  manifest?: unknown
}

/**
 * Traces des plugins d'edition livres avec Savoire : un texte qui en contient
 * une a besoin du plugin. Un plugin du store les declare dans son manifeste
 * (contentPatterns).
 */
export const CONTENT_PATTERNS: Readonly<Record<string, RegExp[]>> = {
  'plugin-callout': [/^\s*>\s*\[!\w+\]/m],
  'plugin-code-block': [/^\s*(?:```|~~~)/m],
  'plugin-note-embed': [/!\[\[/],
  'plugin-module': [/@\[\[/],
  'plugin-task-list': [/^\s*(?:[-*+]|\d+\.) /m],
  'plugin-table': [/^\s*\|.*\|\s*$/m],
  'plugin-footnotes': [/\[\^[^\]\s]+\]/],
  'plugin-base': [/^\s*```base\b/m, /!\[\[[^\]]+\.base\b/i],
  'plugin-board': [/!\[\[[^\]]+\.board\b/i],
  'plugin-animation': [/!\[\[[^\]]+\.anim\b/i],
  'plugin-video': [/!\[\[[^\]]+\.(?:mp4|m4v|webm|mov|ogv|mp3|wav|ogg|oga|m4a|flac)\b/i],
  'plugin-mermaid': [/^\s*```mermaid\b/m, /^\s*>\s*\[!mermaid\]/im],
}

/** Les traces d'un plugin : les siennes, celles de Savoire, ou celles de son manifeste. */
function patternsOf(e: NeedEntry): RegExp[] {
  if (e.contentPatterns) return e.contentPatterns
  const known = CONTENT_PATTERNS[e.id]
  if (known) return known
  const declared = (e.manifest as { contentPatterns?: unknown } | undefined)?.contentPatterns
  if (!Array.isArray(declared)) return []
  return declared.flatMap(p => {
    if (typeof p !== 'string') return []
    try { return [new RegExp(p, 'm')] } catch { return [] }
  })
}

/** Les plugins declares par une note dans ses proprietes (`plugins: a, b:lazy`). */
export function declaredPlugins(text: string): string[] {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const line = fm?.[1].split(/\r?\n/).find(l => /^plugins\s*:/.test(l))
  if (!line) return []
  return line.slice(line.indexOf(':') + 1).split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean)
}

/**
 * Les entrees dont le document a besoin. `editing` : on le modifie, les
 * outils d'edition (menu /, barre) de tous les plugins d'edition sont la.
 */
export function selectNeededEntries<E extends NeedEntry>(entries: readonly E[], path: string, text: string, editing = false): E[] {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const declared = new Set(declaredPlugins(text))
  return entries.filter(e =>
    (e.extensions?.includes(ext) ?? false)
    || declared.has(e.id)
    || (e.editorDefault === true && (editing || patternsOf(e).some(re => re.test(text)))),
  )
}
