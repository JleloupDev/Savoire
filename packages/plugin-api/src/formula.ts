// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// ─── Formules ─────────────────────────────────────────────────────────────
//
// Colonnes calculees des bases, syntaxe proche de Notion :
//
//   prop("Prix") * prop("Quantité")
//   if(prop("Fait"), "✓", "")
//   dateAdd(prop("Début"), 7, "days")
//   prop("Nom").upper()            (a.f(b) vaut f(a, b))
//
// Un petit langage maison, jamais de code JavaScript : une formule ne lit que
// les proprietes de SA ligne, ne boucle pas, et sa taille est bornee. Le meme
// code tourne partout (navigateur, bureau, pair indexeur).
//
// Valeurs : nombre, texte, booleen, date, liste, vide (null). Une date sort
// en 'YYYY-MM-DD' (ou date-heure ISO si elle a une heure).

import type { PropertyValue } from './properties'
import type { FilterOp, QueryField, QueryFilter } from './query'

export const FORMULA_MAX_LENGTH = 2000
const MAX_DEPTH = 64

type Value = number | string | boolean | null | Date | Value[]

type Node =
  | { k: 'lit'; v: Value }
  | { k: 'prop'; name: string }
  | { k: 'un'; op: string; a: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'tern'; c: Node; a: Node; b: Node }
  | { k: 'call'; fn: string; args: Node[] }
  | { k: 'list'; items: Node[] }

/** Ce dont une formule a besoin pour une ligne. */
export interface FormulaRow {
  title: string
  values: Record<string, PropertyValue | undefined>
  /** Calcul sur plusieurs lignes (bloc de requete) : leur nombre, pour count(). */
  rowCount?: number
}

export interface CompiledFormula {
  readonly source: string
  /** Proprietes lues par la formule (pour savoir quoi recalculer). */
  readonly props: readonly string[]
  /** Vrai si la formule utilise une fonction d'agregat (sum, mean, min, max, median, count). */
  readonly aggregates: boolean
  evaluate(row: FormulaRow, now?: Date): FormulaResult
  /**
   * Agregats simples de la formule (sum(prop("x")), count()...), quand un
   * moteur de requetes peut tous les calculer : chaque agregat porte sur une
   * propriete nue (ou rien pour count), aucune propriete hors agregat, pas de
   * median. null sinon.
   */
  readonly aggregateCalls: readonly FormulaAggregateCall[] | null
  /** Evalue avec les valeurs des agregats deja calculees (cle : aggregateKey). */
  evaluateAggregates(values: ReadonlyMap<string, PropertyValue>, now?: Date): FormulaResult
  /**
   * La formule en filtre declaratif, quand c'est exactement la meme
   * condition : comparaisons d'une propriete a un nombre ou a un booleen,
   * empty(), and, or, not. null sinon (comparaisons de textes comprises : le
   * moteur les fait sans casse ni accents).
   */
  toFilter(): QueryFilter | null
}

export interface FormulaAggregateCall {
  fn: 'sum' | 'mean' | 'min' | 'max' | 'count'
  /** Propriete agregee ; absente pour count(). */
  prop?: string
}

export function aggregateKey(c: FormulaAggregateCall): string {
  return `${c.fn}:${c.prop ?? ''}`
}

export type FormulaResult = { ok: true; value: PropertyValue } | { ok: false; error: string }

export class FormulaError extends Error {
  constructor(message: string, readonly pos?: number) {
    super(pos === undefined ? message : `${message} (caractère ${pos + 1})`)
  }
}

// ── Analyse ──────────────────────────────────────────────────────────────

interface Tok { t: 'num' | 'str' | 'id' | 'op' | 'end'; v: string; pos: number }

const OPS = ['==', '!=', '>=', '<=', '&&', '||', '+', '-', '*', '/', '%', '^', '>', '<', '!', '(', ')', ',', '.', '?', ':', '[', ']']

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i))!
      out.push({ t: 'num', v: m[0], pos: i }); i += m[0].length; continue
    }
    if (c === '"' || c === "'" || c === '“' || c === '”') {
      const close = c === '“' ? '”' : c
      let s = ''
      let j = i + 1
      for (; j < src.length && src[j] !== close; j++) {
        if (src[j] === '\\' && j + 1 < src.length) { j++; s += src[j] === 'n' ? '\n' : src[j] } else s += src[j]
      }
      if (j >= src.length) throw new FormulaError('Texte non fermé', i)
      out.push({ t: 'str', v: s, pos: i }); i = j + 1; continue
    }
    if (/[\p{L}_]/u.test(c)) {
      const m = /^[\p{L}_][\p{L}\p{N}_]*/u.exec(src.slice(i))!
      out.push({ t: 'id', v: m[0], pos: i }); i += m[0].length; continue
    }
    const op = OPS.find(o => src.startsWith(o, i))
    if (!op) throw new FormulaError(`Caractère inattendu « ${c} »`, i)
    out.push({ t: 'op', v: op, pos: i }); i += op.length
  }
  out.push({ t: 'end', v: '', pos: src.length })
  return out
}

const WORD_OPS: Record<string, string> = { and: '&&', or: '||', not: '!' }

class Parser {
  private i = 0
  private depth = 0
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok { return this.toks[this.i] }
  private next(): Tok { return this.toks[this.i++] }
  private isOp(v: string): boolean {
    const t = this.peek()
    return (t.t === 'op' && t.v === v) || (t.t === 'id' && WORD_OPS[t.v.toLowerCase()] === v)
  }
  private expect(v: string): void {
    const t = this.next()
    if (t.t !== 'op' || t.v !== v) throw new FormulaError(t.t === 'end' ? `« ${v} » attendu en fin de formule` : `« ${v} » attendu`, t.pos)
  }

  parse(): Node {
    const n = this.ternary()
    const t = this.peek()
    if (t.t !== 'end') throw new FormulaError(`« ${t.v} » inattendu`, t.pos)
    return n
  }

  private enter(): void { if (++this.depth > MAX_DEPTH) throw new FormulaError('Formule trop imbriquée') }

  private ternary(): Node {
    this.enter()
    const c = this.or()
    let n = c
    if (this.isOp('?')) {
      this.next()
      const a = this.ternary()
      this.expect(':')
      const b = this.ternary()
      n = { k: 'tern', c, a, b }
    }
    this.depth--
    return n
  }

  private binary(ops: string[], sub: () => Node, right = false): Node {
    let a = sub()
    for (;;) {
      const op = ops.find(o => this.isOp(o))
      if (!op) return a
      this.next()
      const b = right ? this.binary(ops, sub, true) : sub()
      a = { k: 'bin', op, a, b }
      if (right) return a
    }
  }

  private or(): Node { return this.binary(['||'], () => this.and()) }
  private and(): Node { return this.binary(['&&'], () => this.cmp()) }
  private cmp(): Node { return this.binary(['==', '!=', '>=', '<=', '>', '<'], () => this.add()) }
  private add(): Node { return this.binary(['+', '-'], () => this.mul()) }
  private mul(): Node { return this.binary(['*', '/', '%'], () => this.unary()) }

  private unary(): Node {
    if (this.isOp('!') || this.isOp('-') || this.isOp('+')) {
      const op = this.isOp('!') ? '!' : this.peek().v
      this.next()
      this.enter()
      const a = this.unary()
      this.depth--
      return { k: 'un', op, a }
    }
    return this.pow()
  }

  private pow(): Node {
    const a = this.postfix()
    if (this.isOp('^')) { this.next(); return { k: 'bin', op: '^', a, b: this.unary() } }
    return a
  }

  private postfix(): Node {
    let n = this.primary()
    while (this.isOp('.')) {
      this.next()
      const t = this.next()
      if (t.t !== 'id') throw new FormulaError('Nom de fonction attendu après « . »', t.pos)
      const args = this.isOp('(') ? this.args() : []
      n = this.call(t, [n, ...args])
    }
    return n
  }

  private args(): Node[] {
    this.expect('(')
    const args: Node[] = []
    if (!this.isOp(')')) {
      do { args.push(this.ternary()) } while (this.isOp(',') && this.next())
    }
    this.expect(')')
    return args
  }

  private call(t: Tok, args: Node[]): Node {
    const fn = t.v.toLowerCase()
    if (fn === 'prop') {
      if (args.length !== 1 || args[0].k !== 'lit' || typeof args[0].v !== 'string') throw new FormulaError('prop() attend un nom entre guillemets', t.pos)
      return { k: 'prop', name: args[0].v }
    }
    const def = FUNCTIONS[fn]
    if (!def) throw new FormulaError(`Fonction inconnue « ${t.v} »`, t.pos)
    if (args.length < def.min || args.length > def.max) {
      throw new FormulaError(`${t.v}() attend ${def.min === def.max ? def.min : `${def.min} à ${def.max === Infinity ? 'n' : def.max}`} argument${def.max > 1 ? 's' : ''}`, t.pos)
    }
    return { k: 'call', fn, args }
  }

  private primary(): Node {
    const t = this.next()
    switch (t.t) {
      case 'num': return { k: 'lit', v: Number(t.v) }
      case 'str': return { k: 'lit', v: t.v }
      case 'id': {
        const low = t.v.toLowerCase()
        if (low === 'true') return { k: 'lit', v: true }
        if (low === 'false') return { k: 'lit', v: false }
        if (this.isOp('(')) return this.call(t, this.args())
        if (low === 'now' || low === 'today') return this.call(t, [])
        throw new FormulaError(`« ${t.v} » inconnu (une propriété s'écrit prop("${t.v}"))`, t.pos)
      }
      case 'op':
        if (t.v === '(') {
          const n = this.ternary()
          this.expect(')')
          return n
        }
        if (t.v === '[') {
          const items: Node[] = []
          if (!this.isOp(']')) {
            do { items.push(this.ternary()) } while (this.isOp(',') && this.next())
          }
          this.expect(']')
          return { k: 'list', items }
        }
        throw new FormulaError(`« ${t.v} » inattendu`, t.pos)
      default:
        throw new FormulaError('Formule incomplète', t.pos)
    }
  }
}

// ── Valeurs ──────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

function isEmpty(v: Value): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0)
}

function asNumber(v: Value): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (v === null || v === '') return 0
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'string') {
    const n = Number(v.replace(',', '.').trim())
    if (Number.isFinite(n)) return n
  }
  throw new FormulaError(`« ${asText(v)} » n'est pas un nombre`)
}

/** Un nombre, ou un texte qui en est un (« 3 », « 3,5 ») : les proprietes arrivent souvent en texte. */
function isNumeric(v: Value): boolean {
  if (typeof v === 'number') return true
  if (typeof v !== 'string' || v.trim() === '') return false
  return Number.isFinite(Number(v.replace(',', '.').trim()))
}

function asBool(v: Value): boolean {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  if (typeof v === 'number') return v !== 0
  return !isEmpty(v)
}

function hasTime(d: Date): boolean {
  return d.getUTCHours() !== 0 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0
}

function dateText(d: Date): string {
  return hasTime(d) ? d.toISOString() : d.toISOString().slice(0, 10)
}

function asText(v: Value): string {
  if (v === null) return ''
  if (v instanceof Date) return dateText(v)
  if (Array.isArray(v)) return v.map(asText).join(', ')
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e10) / 1e10)
  return String(v)
}

function asDate(v: Value): Date {
  if (v instanceof Date) return v
  if (typeof v === 'string' && DATE_RE.test(v.trim())) {
    const s = v.trim()
    const d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s.replace(' ', 'T'))
    if (!Number.isNaN(d.getTime())) return d
  }
  throw new FormulaError(`« ${asText(v)} » n'est pas une date`)
}

function asList(v: Value): Value[] {
  if (Array.isArray(v)) return v
  return v === null ? [] : [v]
}

function isDateLike(v: Value): boolean {
  return v instanceof Date || (typeof v === 'string' && DATE_RE.test(v.trim()))
}

function compare(a: Value, b: Value): number {
  if (isDateLike(a) && isDateLike(b)) return asDate(a).getTime() - asDate(b).getTime()
  if (typeof a === 'number' || typeof b === 'number') return asNumber(a) - asNumber(b)
  return asText(a).localeCompare(asText(b))
}

function equals(a: Value, b: Value): boolean {
  if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b)
  if (Array.isArray(a) || Array.isArray(b)) return asText(a) === asText(b)
  if (typeof a === 'boolean' || typeof b === 'boolean') return asBool(a) === asBool(b)
  try { return compare(a, b) === 0 } catch { return false }
}

function finite(n: number): number {
  if (!Number.isFinite(n)) throw new FormulaError('Calcul impossible (division par zéro ?)')
  return n
}

const UNITS: Record<string, 'ms' | 's' | 'min' | 'h' | 'd' | 'w' | 'mo' | 'y'> = {
  milliseconds: 'ms', millisecond: 'ms',
  seconds: 's', second: 's', secondes: 's', seconde: 's',
  minutes: 'min', minute: 'min',
  hours: 'h', hour: 'h', heures: 'h', heure: 'h',
  days: 'd', day: 'd', jours: 'd', jour: 'd',
  weeks: 'w', week: 'w', semaines: 'w', semaine: 'w',
  months: 'mo', month: 'mo', mois: 'mo',
  years: 'y', year: 'y', années: 'y', année: 'y', ans: 'y', an: 'y',
}
const MS = { ms: 1, s: 1e3, min: 6e4, h: 36e5, d: 864e5, w: 6048e5 }

function unitOf(v: Value): 'ms' | 's' | 'min' | 'h' | 'd' | 'w' | 'mo' | 'y' {
  const u = UNITS[asText(v).toLowerCase()]
  if (!u) throw new FormulaError(`Unité inconnue « ${asText(v)} » (days, weeks, months, years…)`)
  return u
}

function addTo(d: Date, n: number, unit: ReturnType<typeof unitOf>): Date {
  if (unit === 'mo' || unit === 'y') {
    const r = new Date(d.getTime())
    r.setUTCMonth(r.getUTCMonth() + Math.trunc(n) * (unit === 'y' ? 12 : 1))
    return r
  }
  return new Date(d.getTime() + n * MS[unit])
}

function between(a: Date, b: Date, unit: ReturnType<typeof unitOf>): number {
  if (unit === 'mo' || unit === 'y') {
    let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth())
    if (months > 0 && a.getUTCDate() < b.getUTCDate()) months--
    if (months < 0 && a.getUTCDate() > b.getUTCDate()) months++
    return unit === 'y' ? Math.trunc(months / 12) : months
  }
  return Math.trunc((a.getTime() - b.getTime()) / MS[unit])
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function formatDate(d: Date, fmt: string): string {
  return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, t => {
    switch (t) {
      case 'YYYY': return pad(d.getUTCFullYear(), 4)
      case 'MM': return pad(d.getUTCMonth() + 1)
      case 'DD': return pad(d.getUTCDate())
      case 'HH': return pad(d.getUTCHours())
      case 'mm': return pad(d.getUTCMinutes())
      default: return pad(d.getUTCSeconds())
    }
  })
}

// ── Fonctions ────────────────────────────────────────────────────────────

/** min / max : nombres, ou dates (le resultat reste une date). */
/**
 * Les agregats (sum, mean, median, min, max) ne comptent que les NOMBRES,
 * comme le moteur de requetes et les totaux des colonnes : un « 3 » ecrit en
 * texte reste du texte (typer la propriete en nombre pour qu'il compte).
 */
function numbersOf(args: Value[]): number[] {
  return args.flatMap(asList).filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
}

/** min / max : les nombres s'il y en a ; sinon des dates ; sinon les textes, compares tels quels. */
function extreme(args: Value[], dir: 1 | -1): Value {
  const xs = args.flatMap(asList).filter(x => !isEmpty(x))
  if (!xs.length) return null
  const nums = numbersOf(xs)
  if (nums.length) return nums.reduce((m, n) => (n - m) * dir > 0 ? n : m)
  if (xs.every(isDateLike)) return xs.map(asDate).reduce((m, d) => (d.getTime() - m.getTime()) * dir > 0 ? d : m)
  const texts = xs.filter((x): x is string => typeof x === 'string')
  if (!texts.length) return null
  return texts.reduce((m, t) => (dir > 0 ? t > m : t < m) ? t : m)
}

const AGGREGATES = new Set(['sum', 'mean', 'min', 'max', 'median', 'count'])

interface Env { row: FormulaRow; now: Date; presets?: ReadonlyMap<string, PropertyValue> }
type Lazy = () => Value
interface FnDef { min: number; max: number; run(args: Lazy[], env: Env): Value }

const eager = (min: number, max: number, run: (a: Value[], env: Env) => Value): FnDef =>
  ({ min, max, run: (args, env) => run(args.map(f => f()), env) })

const num1 = (f: (n: number) => number): FnDef => eager(1, 1, ([a]) => finite(f(asNumber(a))))

const FUNCTIONS: Record<string, FnDef> = {
  // Logique (paresseuses : la branche non choisie n'est pas calculee)
  if: { min: 3, max: 3, run: ([c, a, b]) => asBool(c()) ? a() : b() },
  ifs: {
    min: 3, max: Infinity, run: args => {
      let i = 0
      for (; i + 1 < args.length; i += 2) if (asBool(args[i]())) return args[i + 1]()
      return i < args.length ? args[i]() : null
    },
  },
  empty: eager(1, 1, ([a]) => isEmpty(a)),
  not: eager(1, 1, ([a]) => !asBool(a)),
  // Texte
  concat: eager(1, Infinity, a => a.some(Array.isArray) ? a.flatMap(asList) : a.map(asText).join('')),
  join: eager(2, 2, ([l, sep]) => asList(l).map(asText).join(asText(sep))),
  length: eager(1, 1, ([a]) => Array.isArray(a) ? a.length : asText(a).length),
  lower: eager(1, 1, ([a]) => asText(a).toLowerCase()),
  upper: eager(1, 1, ([a]) => asText(a).toUpperCase()),
  trim: eager(1, 1, ([a]) => asText(a).trim()),
  contains: eager(2, 2, ([a, b]) => Array.isArray(a) ? a.some(x => equals(x, b)) : asText(a).toLowerCase().includes(asText(b).toLowerCase())),
  startswith: eager(2, 2, ([a, b]) => asText(a).startsWith(asText(b))),
  endswith: eager(2, 2, ([a, b]) => asText(a).endsWith(asText(b))),
  replace: eager(3, 3, ([a, b, c]) => asText(a).replace(asText(b), asText(c))),
  replaceall: eager(3, 3, ([a, b, c]) => asText(a).split(asText(b)).join(asText(c))),
  slice: eager(2, 3, ([a, s, e]) => Array.isArray(a)
    ? a.slice(asNumber(s), e === undefined ? undefined : asNumber(e))
    : asText(a).slice(asNumber(s), e === undefined ? undefined : asNumber(e))),
  repeat: eager(2, 2, ([a, n]) => asText(a).repeat(Math.max(0, Math.min(1000, Math.trunc(asNumber(n)))))),
  format: eager(1, 1, ([a]) => asText(a)),
  tonumber: eager(1, 1, ([a]) => { try { return asNumber(a) } catch { return null } }),
  // Nombres
  abs: num1(Math.abs),
  ceil: num1(Math.ceil),
  floor: num1(Math.floor),
  sqrt: num1(Math.sqrt),
  sign: num1(Math.sign),
  round: eager(1, 2, ([a, p]) => {
    const f = 10 ** (p === undefined ? 0 : Math.trunc(asNumber(p)))
    return finite(Math.round(asNumber(a) * f) / f)
  }),
  pow: eager(2, 2, ([a, b]) => finite(asNumber(a) ** asNumber(b))),
  min: eager(1, Infinity, a => extreme(a, -1)),
  max: eager(1, Infinity, a => extreme(a, 1)),
  median: eager(1, Infinity, a => {
    const xs = numbersOf(a).sort((x, y) => x - y)
    if (!xs.length) return null
    const m = xs.length >> 1
    return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2
  }),
  count: eager(0, 1, (a, env) => a.length === 0 ? env.row.rowCount ?? 1 : asList(a[0]).filter(x => !isEmpty(x)).length),
  sum: eager(1, Infinity, a => numbersOf(a).reduce<number>((s, x) => s + x, 0)),
  mean: eager(1, Infinity, a => {
    const xs = numbersOf(a)
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null
  }),
  // Listes
  at: eager(2, 2, ([l, i]) => asList(l).at(Math.trunc(asNumber(i))) ?? null),
  first: eager(1, 1, ([l]) => asList(l)[0] ?? null),
  last: eager(1, 1, ([l]) => asList(l).at(-1) ?? null),
  sort: eager(1, 1, ([l]) => [...asList(l)].sort(compare)),
  reverse: eager(1, 1, ([l]) => [...asList(l)].reverse()),
  unique: eager(1, 1, ([l]) => asList(l).filter((x, i, xs) => xs.findIndex(y => equals(x, y)) === i)),
  // Dates
  now: eager(0, 0, (_, env) => new Date(env.now.getTime())),
  today: eager(0, 0, (_, env) => new Date(Date.UTC(env.now.getUTCFullYear(), env.now.getUTCMonth(), env.now.getUTCDate()))),
  date: eager(1, 1, ([a]) => asDate(a)),
  dateadd: eager(3, 3, ([d, n, u]) => addTo(asDate(d), asNumber(n), unitOf(u))),
  datesubtract: eager(3, 3, ([d, n, u]) => addTo(asDate(d), -asNumber(n), unitOf(u))),
  datebetween: eager(3, 3, ([a, b, u]) => between(asDate(a), asDate(b), unitOf(u))),
  formatdate: eager(2, 2, ([d, f]) => formatDate(asDate(d), asText(f))),
  year: eager(1, 1, ([d]) => asDate(d).getUTCFullYear()),
  month: eager(1, 1, ([d]) => asDate(d).getUTCMonth() + 1),
  day: eager(1, 1, ([d]) => asDate(d).getUTCDate()),
  weekday: eager(1, 1, ([d]) => asDate(d).getUTCDay() || 7),
}

/** Noms des fonctions disponibles (aide de l'editeur). */
export const FORMULA_FUNCTIONS: readonly string[] = ['prop', ...Object.keys(FUNCTIONS)]

// ── Evaluation ───────────────────────────────────────────────────────────

function evalNode(n: Node, env: Env): Value {
  switch (n.k) {
    case 'lit': return n.v
    case 'list': return n.items.map(x => evalNode(x, env))
    case 'prop': {
      if (n.name === 'Nom' || n.name === 'Name' || n.name === '@title') {
        if (!(n.name in env.row.values)) return env.row.title
      }
      const v = env.row.values[n.name]
      return v === undefined ? null : v
    }
    case 'tern': return asBool(evalNode(n.c, env)) ? evalNode(n.a, env) : evalNode(n.b, env)
    case 'un': {
      const a = evalNode(n.a, env)
      if (n.op === '!') return !asBool(a)
      return n.op === '-' ? -asNumber(a) : asNumber(a)
    }
    case 'call': {
      if (env.presets && AGGREGATES.has(n.fn)) {
        const call = simpleAggregate(n)
        if (call) { const v = env.presets.get(aggregateKey(call)); return v === undefined ? null : v as Value }
      }
      return FUNCTIONS[n.fn].run(n.args.map(a => () => evalNode(a, env)), env)
    }
    case 'bin': {
      if (n.op === '&&') return asBool(evalNode(n.a, env)) && asBool(evalNode(n.b, env))
      if (n.op === '||') return asBool(evalNode(n.a, env)) || asBool(evalNode(n.b, env))
      const a = evalNode(n.a, env)
      const b = evalNode(n.b, env)
      switch (n.op) {
        case '+': {
          if (Array.isArray(a) || Array.isArray(b)) return [...asList(a), ...asList(b)]
          // Calcul des que les deux cotes sont des nombres (ou vides) ; sinon on
          // colle les textes. Pour coller deux nombres : concat() ou format().
          const mathA = isNumeric(a) || a === null || a === '' || typeof a === 'boolean'
          const mathB = isNumeric(b) || b === null || b === '' || typeof b === 'boolean'
          if (mathA && mathB) return finite(asNumber(a) + asNumber(b))
          if (typeof a === 'string' && !isDateLike(a) || typeof b === 'string' && !isDateLike(b)) return asText(a) + asText(b)
          return finite(asNumber(a) + asNumber(b))
        }
        case '-':
          if (isDateLike(a) && isDateLike(b)) return asDate(a).getTime() - asDate(b).getTime()
          return finite(asNumber(a) - asNumber(b))
        case '*': return finite(asNumber(a) * asNumber(b))
        case '/': return finite(asNumber(a) / asNumber(b))
        case '%': return finite(asNumber(a) % asNumber(b))
        case '^': return finite(asNumber(a) ** asNumber(b))
        case '==': return equals(a, b)
        case '!=': return !equals(a, b)
        case '>': return compare(a, b) > 0
        case '<': return compare(a, b) < 0
        case '>=': return compare(a, b) >= 0
        case '<=': return compare(a, b) <= 0
      }
    }
  }
  throw new FormulaError('Formule invalide')
}

function output(v: Value): PropertyValue {
  if (v instanceof Date) return dateText(v)
  if (Array.isArray(v)) return v.map(asText)
  if (typeof v === 'number' && !Number.isInteger(v)) return Math.round(v * 1e10) / 1e10
  return v
}

function collect(n: Node, props: Set<string>, calls: Set<string>): void {
  switch (n.k) {
    case 'prop': props.add(n.name); break
    case 'un': collect(n.a, props, calls); break
    case 'bin': collect(n.a, props, calls); collect(n.b, props, calls); break
    case 'tern': collect(n.c, props, calls); collect(n.a, props, calls); collect(n.b, props, calls); break
    case 'call': calls.add(n.fn); n.args.forEach(a => collect(a, props, calls)); break
    case 'list': n.items.forEach(a => collect(a, props, calls)); break
  }
}

// ── Formule vers moteur de requetes ──────────────────────────────────────

const ENGINE_AGGREGATES = new Set(['sum', 'mean', 'min', 'max', 'count'])

/** sum(prop("x")) ou count() : l'appel, sinon null. */
function simpleAggregate(n: Node): FormulaAggregateCall | null {
  if (n.k !== 'call' || !ENGINE_AGGREGATES.has(n.fn)) return null
  const fn = n.fn as FormulaAggregateCall['fn']
  if (n.args.length === 0) return fn === 'count' ? { fn } : null
  if (n.args.length === 1 && n.args[0].k === 'prop') return { fn, prop: n.args[0].name }
  return null
}

/** Tous les agregats simples, ou null si un agregat ou une propriete ne l'est pas. */
function aggregatePlan(ast: Node): FormulaAggregateCall[] | null {
  const out = new Map<string, FormulaAggregateCall>()
  let ok = true
  const walk = (n: Node): void => {
    if (!ok) return
    switch (n.k) {
      case 'prop': ok = false; return
      case 'call': {
        if (AGGREGATES.has(n.fn)) {
          const c = simpleAggregate(n)
          if (!c) { ok = false; return }
          out.set(aggregateKey(c), c)
          return
        }
        n.args.forEach(walk)
        return
      }
      case 'un': walk(n.a); return
      case 'bin': walk(n.a); walk(n.b); return
      case 'tern': walk(n.c); walk(n.a); walk(n.b); return
      case 'list': n.items.forEach(walk); return
    }
  }
  walk(ast)
  return ok && out.size > 0 ? [...out.values()] : null
}

const TITLE_PROPS = new Set(['Nom', 'Name', '@title'])
const fieldOfProp = (name: string): QueryField => TITLE_PROPS.has(name) ? { doc: 'title' } : { prop: name }
const FLIP: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' }
const FILTER_OP: Record<string, FilterOp> = { '==': 'eq', '!=': 'neq', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' }

function toFilterNode(n: Node): QueryFilter | null {
  if (n.k === 'bin' && (n.op === '&&' || n.op === '||')) {
    const a = toFilterNode(n.a), b = toFilterNode(n.b)
    if (!a || !b) return null
    return n.op === '&&' ? { and: [a, b] } : { or: [a, b] }
  }
  if (n.k === 'un' && n.op === '!') { const a = toFilterNode(n.a); return a ? { not: a } : null }
  if (n.k === 'call' && n.fn === 'not' && n.args.length === 1) { const a = toFilterNode(n.args[0]); return a ? { not: a } : null }
  if (n.k === 'call' && n.fn === 'empty' && n.args.length === 1 && n.args[0].k === 'prop') {
    return { field: fieldOfProp(n.args[0].name), op: 'empty' }
  }
  if (n.k === 'bin' && n.op in FILTER_OP) {
    let prop: string, lit: Value, op = n.op
    if (n.a.k === 'prop' && n.b.k === 'lit') { prop = n.a.name; lit = n.b.v }
    else if (n.b.k === 'prop' && n.a.k === 'lit') { prop = n.b.name; lit = n.a.v; op = FLIP[op] }
    else return null
    const field = fieldOfProp(prop)
    const empty: QueryFilter = { field, op: 'empty' }
    if (typeof lit === 'boolean') {
      // equals(v, bool) : faux pour une valeur vide.
      if (op === '==') return { field, op: 'eq', value: lit }
      if (op === '!=') return { or: [empty, { field, op: 'neq', value: lit }] }
      return null
    }
    if (typeof lit !== 'number') return null
    if (op === '==') return { field, op: 'eq', value: lit }
    if (op === '!=') return { or: [empty, { field, op: 'neq', value: lit }] }
    // Une valeur vide vaut 0 dans une comparaison de nombres.
    const zero = op === '<' ? 0 < lit : op === '<=' ? 0 <= lit : op === '>' ? 0 > lit : 0 >= lit
    const cmp: QueryFilter = { field, op: FILTER_OP[op], value: lit }
    return zero ? { or: [empty, cmp] } : cmp
  }
  return null
}

/** Compile une formule ; lance FormulaError (message en francais) si elle est mal ecrite. */
export function compileFormula(source: string): CompiledFormula {
  if (source.length > FORMULA_MAX_LENGTH) throw new FormulaError(`Formule trop longue (${FORMULA_MAX_LENGTH} caractères au plus)`)
  if (!source.trim()) throw new FormulaError('Formule vide')
  const ast = new Parser(tokenize(source)).parse()
  const props = new Set<string>()
  const calls = new Set<string>()
  collect(ast, props, calls)
  return {
    source,
    props: [...props],
    aggregates: [...calls].some(c => AGGREGATES.has(c)),
    evaluate(row, now = new Date()) {
      return run({ row, now })
    },
    aggregateCalls: aggregatePlan(ast),
    evaluateAggregates(values, now = new Date()) {
      return run({ row: { title: '', values: {} }, now, presets: values })
    },
    toFilter: () => toFilterNode(ast),
  }
  function run(env: Env): FormulaResult {
    try {
      return { ok: true, value: output(evalNode(ast, env)) }
    } catch (err) {
      if (err instanceof FormulaError) return { ok: false, error: err.message }
      if (err instanceof RangeError) return { ok: false, error: 'Calcul trop profond' }
      throw err
    }
  }
}

/** Compile sans lancer : la formule, ou le message d'erreur. */
export function tryCompileFormula(source: string): { formula: CompiledFormula } | { error: string } {
  try {
    return { formula: compileFormula(source) }
  } catch (err) {
    if (err instanceof FormulaError) return { error: err.message }
    throw err
  }
}
