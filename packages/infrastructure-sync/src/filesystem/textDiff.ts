// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Diff de texte, pour appliquer a un texte CRDT une modification faite hors
// de l'application (un autre editeur a reecrit le fichier). On ne remplace
// jamais tout le texte : seules les parties changees sont supprimees puis
// inserees, le reste garde son identite CRDT (curseurs, fusion avec les
// frappes concurrentes).
//
// Methode : on retire le debut et la fin communs, on compare le milieu ligne
// par ligne (algorithme de Myers, plus courte suite d'editions), puis chaque
// bloc de lignes change est affine caractere par caractere (debut et fin
// communs). Au-dela d'un certain cout, on se contente du bloc unique.
//
// Les positions sont en unites UTF-16 (String.length), comme le texte CRDT.
// Une coupure ne tombe jamais au milieu d'une paire de substitution.

export type TextEdit =
  | { retain: number }
  | { delete: number }
  | { insert: string }

/** Au-dela de ce nombre d'editions de lignes, on renonce au diff fin. */
const MAX_LINE_EDITS = 500

/** Delta qui transforme `a` en `b`. Vide si les deux textes sont egaux. */
export function diffText(a: string, b: string): TextEdit[] {
  if (a === b) return []
  const out = new DeltaBuilder()
  const prefix = commonPrefix(a, b)
  const suffix = commonSuffix(a, b, prefix)
  out.retain(prefix)
  const midA = a.slice(prefix, a.length - suffix)
  const midB = b.slice(prefix, b.length - suffix)
  const lineHunks = diffLines(midA, midB)
  if (!lineHunks) {
    out.replace(midA.length, midB)
  } else {
    for (const h of lineHunks) {
      if (h.kind === 'same') out.retain(h.a.length)
      else refine(out, h.a, h.b)
    }
  }
  return out.finish()
}

/** Applique un delta a une chaine (verification, tests). */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  let out = ''
  let pos = 0
  for (const e of edits) {
    if ('retain' in e) { out += text.slice(pos, pos + e.retain); pos += e.retain }
    else if ('delete' in e) pos += e.delete
    else out += e.insert
  }
  return out + text.slice(pos)
}

// ── Interne ──────────────────────────────────────────────────────────────────

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  // Ne pas couper une paire : reculer si le dernier commun est un debut de paire.
  if (i > 0 && isHighSurrogate(a.charCodeAt(i - 1))) i--
  return i
}

function commonSuffix(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix
  let i = 0
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  if (i > 0 && isLowSurrogate(a.charCodeAt(a.length - i))) i--
  return i
}

/** Remplace `a` par `b` en gardant leurs debut et fin communs. */
function refine(out: DeltaBuilder, a: string, b: string): void {
  const prefix = commonPrefix(a, b)
  const suffix = commonSuffix(a, b, prefix)
  out.retain(prefix)
  out.replace(a.length - prefix - suffix, b.slice(prefix, b.length - suffix))
  out.retain(suffix)
}

/** Lignes avec leur fin (« \n » compris) : leur concatenation redonne le texte. */
function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

type Hunk = { kind: 'same'; a: string } | { kind: 'change'; a: string; b: string }

/**
 * Blocs de lignes communes et changees (Myers, O((N+M)D)). Null si le diff
 * coute trop : l'appelant remplace alors le milieu d'un bloc.
 */
function diffLines(a: string, b: string): Hunk[] | null {
  const la = splitLines(a)
  const lb = splitLines(b)
  const n = la.length
  const m = lb.length
  const max = Math.min(n + m, MAX_LINE_EDITS)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
        ? v[offset + k + 1]
        : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && la[x] === lb[y]) { x++; y++ }
      v[offset + k] = x
      if (x >= n && y >= m) { found = true; break }
    }
  }
  if (!found) return null

  // Remontee : suite d'operations (egal, supprime, insere) de la fin au debut.
  const ops: ('=' | '-' | '+')[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d]
    const k = x - y
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1
    const prevX = vd[offset + prevK]
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { ops.push('='); x--; y-- }
    if (x === prevX) { ops.push('+'); y-- } else { ops.push('-'); x-- }
  }
  while (x > 0 && y > 0) { ops.push('='); x--; y-- }
  ops.reverse()

  const hunks: Hunk[] = []
  let ia = 0
  let ib = 0
  let i = 0
  while (i < ops.length) {
    if (ops[i] === '=') {
      let same = ''
      while (i < ops.length && ops[i] === '=') { same += la[ia++]; ib++; i++ }
      hunks.push({ kind: 'same', a: same })
    } else {
      let delA = ''
      let insB = ''
      while (i < ops.length && ops[i] !== '=') {
        if (ops[i] === '-') delA += la[ia++]
        else insB += lb[ib++]
        i++
      }
      hunks.push({ kind: 'change', a: delA, b: insB })
    }
  }
  return hunks
}

/** Construit un delta compact : operations voisines de meme sorte fusionnees. */
class DeltaBuilder {
  private readonly ops: TextEdit[] = []

  retain(n: number): void {
    if (n <= 0) return
    const last = this.ops.at(-1)
    if (last && 'retain' in last) last.retain += n
    else this.ops.push({ retain: n })
  }

  replace(deleteCount: number, insert: string): void {
    if (deleteCount > 0) {
      const last = this.ops.at(-1)
      if (last && 'delete' in last) last.delete += deleteCount
      else this.ops.push({ delete: deleteCount })
    }
    if (insert) {
      const last = this.ops.at(-1)
      if (last && 'insert' in last) last.insert += insert
      else this.ops.push({ insert })
    }
  }

  finish(): TextEdit[] {
    while (this.ops.length && 'retain' in this.ops[this.ops.length - 1]) this.ops.pop()
    return this.ops
  }
}
