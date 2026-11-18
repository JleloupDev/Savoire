// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Accepter une suggestion de texte ligne par ligne : les differences entre
// le passage et le texte propose, par blocs de lignes changees (hunks). Chaque
// bloc s'accepte ou non ; mergeHunks rend le texte avec les seuls blocs
// acceptes. Plus longue sous-suite commune sur les lignes (passages courts).

export interface LineHunk {
  index: number
  /** Lignes du passage que le bloc remplace (vide : ajout pur). */
  removed: string[]
  /** Lignes proposees (vide : suppression pure). */
  added: string[]
}

type Op = { kind: 'same'; line: string } | { kind: 'hunk'; hunk: LineHunk }

/** Au-dela, pas de decoupage : la suggestion s'accepte en bloc. */
export const MAX_DIFF_LINES = 2000

function ops(before: string, after: string): Op[] | null {
  const a = before.split('\n'), b = after.split('\n')
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return null
  // lcs[i][j] : plus longue sous-suite commune de a[i..] et b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  const out: Op[] = []
  let current: LineHunk | null = null
  const hunk = (): LineHunk => {
    if (!current) { current = { index: out.filter(o => o.kind === 'hunk').length, removed: [], added: [] }; out.push({ kind: 'hunk', hunk: current }) }
    return current
  }
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: 'same', line: a[i] }); current = null; i++; j++ }
    else if (j < b.length && (i >= a.length || lcs[i][j + 1] >= lcs[i + 1][j])) { hunk().added.push(b[j]); j++ }
    else { hunk().removed.push(a[i]); i++ }
  }
  return out
}

/** Les blocs de lignes changees, dans l'ordre. Vide : rien ne change, ou trop long. */
export function lineHunks(before: string, after: string): LineHunk[] {
  return (ops(before, after) ?? []).flatMap(o => (o.kind === 'hunk' ? [o.hunk] : []))
}

/** Le passage avec les seuls blocs acceptes (indices de lineHunks). */
export function mergeHunks(before: string, after: string, accepted: Iterable<number>): string {
  const ok = new Set(accepted)
  const all = ops(before, after)
  if (!all) return ok.size ? after : before
  const lines: string[] = []
  for (const o of all) {
    if (o.kind === 'same') lines.push(o.line)
    else lines.push(...(ok.has(o.hunk.index) ? o.hunk.added : o.hunk.removed))
  }
  return lines.join('\n')
}
