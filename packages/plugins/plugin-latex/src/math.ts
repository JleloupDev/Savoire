// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Formules LaTeX -> MathML, que les navigateurs affichent eux-memes (MathML
// Core : Chrome 109+, Firefox, Safari). Aucune dependance.
//
// Couvre l'usage courant : lettres, nombres, operateurs, exposants et
// indices, \frac, \sqrt, sommes et integrales avec bornes, lettres grecques,
// symboles, \left \right, \text, \mathbf / \mathbb / \mathcal, accents
// (\hat, \bar, \vec...), matrices et cas. Une commande inconnue s'affiche en
// rouge, telle quelle : rien ne disparait en silence.

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ', varepsilon: 'ε', zeta: 'ζ', eta: 'η',
  theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π',
  varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ',
  varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ',
  Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

/** Symboles qui sont des operateurs ou des relations (mo). */
const OPERATORS: Record<string, string> = {
  times: '×', cdot: '⋅', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '∙',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃',
  cong: '≅', propto: '∝', ll: '≪', gg: '≫', in: '∈', notin: '∉', ni: '∋', subset: '⊂', supset: '⊃',
  subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', wedge: '∧', land: '∧', vee: '∨', lor: '∨',
  neg: '¬', lnot: '¬', forall: '∀', exists: '∃', nexists: '∄', to: '→', rightarrow: '→', leftarrow: '←',
  gets: '←', leftrightarrow: '↔', Rightarrow: '⇒', implies: '⟹', Leftarrow: '⇐', Leftrightarrow: '⇔', iff: '⟺',
  mapsto: '↦', uparrow: '↑', downarrow: '↓', mid: '∣', parallel: '∥', perp: '⊥', oplus: '⊕', otimes: '⊗',
  ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…', colon: ':', vert: '|', Vert: '‖',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', lbrace: '{', rbrace: '}',
}

/** Symboles ordinaires (mi). */
const IDENTIFIERS: Record<string, string> = {
  infty: '∞', partial: '∂', nabla: '∇', emptyset: '∅', varnothing: '∅', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ',
  Im: 'ℑ', aleph: 'ℵ', angle: '∠', triangle: '△', prime: '′', degree: '°',
}

/** Grands operateurs : bornes dessous/dessus en mode display. */
const LARGE: Record<string, string> = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', iiint: '∭', oint: '∮', bigcup: '⋃',
  bigcap: '⋂', bigoplus: '⨁', bigotimes: '⨂',
}

/** Fonctions en romain : sin, log, lim... */
const FUNCTIONS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh',
  'tanh', 'log', 'ln', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg',
  'gcd', 'arg', 'Pr', 'mod'])
const LIMIT_FUNCTIONS = new Set(['lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'gcd', 'Pr'])

const ACCENTS: Record<string, string> = {
  hat: '^', widehat: '^', bar: '¯', overline: '¯', vec: '→', overrightarrow: '→', tilde: '~', widetilde: '~',
  dot: '˙', ddot: '¨', check: 'ˇ', breve: '˘',
}

const FONTS: Record<string, string> = {
  mathbf: 'bold', boldsymbol: 'bold-italic', mathit: 'italic', mathrm: 'normal', mathsf: 'sans-serif',
  mathtt: 'monospace', mathbb: 'double-struck', mathcal: 'script', mathscr: 'script', mathfrak: 'fraktur',
  operatorname: 'normal',
}

const MATRICES: Record<string, [string, string]> = {
  matrix: ['', ''], pmatrix: ['(', ')'], bmatrix: ['[', ']'], Bmatrix: ['{', '}'], vmatrix: ['|', '|'],
  Vmatrix: ['‖', '‖'], cases: ['{', ''], array: ['', ''], aligned: ['', ''], align: ['', ''], 'align*': ['', ''],
  gathered: ['', ''], split: ['', ''],
}

const SPACES: Record<string, string> = { ',': '0.1667em', ':': '0.2222em', ';': '0.2778em', '!': '-0.1667em', quad: '1em', qquad: '2em', ' ': '0.25em' }

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type Token = { t: 'cmd'; v: string } | { t: 'char'; v: string } | { t: 'num'; v: string } | { t: 'text'; v: string }

/** Commandes dont l'argument est du texte : lu tel quel, espaces compris. */
const TEXT_COMMANDS = new Set(['text', 'textrm', 'textit', 'textbf', 'mbox', 'textnormal'])

function tokenize(src: string): Token[] {
  const out: Token[] = []
  for (let i = 0; i < src.length;) {
    const c = src[i]
    if (c === '\\') {
      const m = /^\\([A-Za-z]+\*?|.)/.exec(src.slice(i))
      if (!m) { i++; continue }
      i += m[0].length
      if (TEXT_COMMANDS.has(m[1])) {
        let j = i
        while (src[j] === ' ') j++
        if (src[j] === '{') {
          let depth = 0
          let k = j
          for (; k < src.length; k++) {
            if (src[k] === '{') depth++
            else if (src[k] === '}' && --depth === 0) break
          }
          out.push({ t: 'text', v: src.slice(j + 1, k) })
          i = k + 1
          continue
        }
      }
      out.push({ t: 'cmd', v: m[1] })
      // Les espaces apres une commande nommee ne comptent pas.
      if (/^[A-Za-z]/.test(m[1])) while (src[i] === ' ') i++
      continue
    }
    if (/\s/.test(c)) { i++; continue }
    if (c === '%') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i))!
      out.push({ t: 'num', v: m[0] })
      i += m[0].length
      continue
    }
    out.push({ t: 'char', v: c })
    i++
  }
  return out
}

class Parser {
  private i = 0
  constructor(private readonly tokens: Token[], private readonly display: boolean, private readonly raw: string) {}

  /** Une suite d'elements jusqu'a `}`, `&`, `\\`, `\right`, `\end` ou la fin. */
  parseRow(stop: (tok: Token) => boolean = () => false): string {
    const items: string[] = []
    while (this.i < this.tokens.length) {
      const tok = this.tokens[this.i]
      if (stop(tok)) break
      if (tok.t === 'char' && tok.v === '}') break
      const atom = this.parseAtom()
      if (atom === null) continue
      items.push(this.parseScripts(atom.html, atom.large))
    }
    return items.length === 1 ? items[0] : `<mrow>${items.join('')}</mrow>`
  }

  private parseScripts(base: string, large: boolean): string {
    let sub: string | null = null
    let sup: string | null = null
    let primes = ''
    for (;;) {
      const tok = this.tokens[this.i]
      if (!tok || tok.t !== 'char') break
      if (tok.v === '_' && sub === null) { this.i++; sub = this.parseArgument() }
      else if (tok.v === '^' && sup === null) { this.i++; sup = this.parseArgument() }
      else if (tok.v === "'") { this.i++; primes += '′' }
      else break
    }
    if (primes) sup = sup ? `<mrow><mo>${primes}</mo>${sup}</mrow>` : `<mo>${primes}</mo>`
    if (sub === null && sup === null) return base
    const under = large && this.display
    if (sub !== null && sup !== null) return under ? `<munderover>${base}${sub}${sup}</munderover>` : `<msubsup>${base}${sub}${sup}</msubsup>`
    if (sub !== null) return under ? `<munder>${base}${sub}</munder>` : `<msub>${base}${sub}</msub>`
    return under ? `<mover>${base}${sup}</mover>` : `<msup>${base}${sup}</msup>`
  }

  /** Un argument : {groupe} ou un seul element. */
  parseArgument(): string {
    const tok = this.tokens[this.i]
    if (!tok) return '<mrow></mrow>'
    if (tok.t === 'char' && tok.v === '{') {
      this.i++
      const row = this.parseRow()
      this.expect('}')
      return row.startsWith('<mrow>') ? row : `<mrow>${row}</mrow>`
    }
    const atom = this.parseAtom()
    return atom?.html ?? '<mrow></mrow>'
  }

  /** Texte brut d'un argument {…} (pour \text, \begin...). */
  private rawArgument(): string {
    const tok = this.tokens[this.i]
    if (!tok || tok.t !== 'char' || tok.v !== '{') return ''
    this.i++
    let depth = 1
    let out = ''
    while (this.i < this.tokens.length) {
      const t = this.tokens[this.i++]
      if (t.t === 'char' && t.v === '{') depth++
      if (t.t === 'char' && t.v === '}' && --depth === 0) break
      out += t.t === 'cmd' ? (/^[A-Za-z]/.test(t.v) ? `\\${t.v} ` : t.v) : t.v
    }
    return out
  }

  private optional(): string | null {
    const tok = this.tokens[this.i]
    if (!tok || tok.t !== 'char' || tok.v !== '[') return null
    this.i++
    const row = this.parseRow(t => t.t === 'char' && t.v === ']')
    this.expect(']')
    return row
  }

  private expect(c: string): void {
    const tok = this.tokens[this.i]
    if (tok && tok.t === 'char' && tok.v === c) this.i++
  }

  private parseAtom(): { html: string; large: boolean } | null {
    const tok = this.tokens[this.i++]
    if (tok.t === 'num') return { html: `<mn>${tok.v}</mn>`, large: false }
    if (tok.t === 'text') return { html: `<mtext>${esc(tok.v.replace(/\\([%$&#_{}])/g, '$1'))}</mtext>`, large: false }
    if (tok.t === 'char') {
      const c = tok.v
      if (c === '{') {
        const row = this.parseRow()
        this.expect('}')
        return { html: row.startsWith('<mrow>') ? row : `<mrow>${row}</mrow>`, large: false }
      }
      if (c === '~') return { html: '<mspace width="0.25em"></mspace>', large: false }
      if (/[A-Za-z]/.test(c)) return { html: `<mi>${c}</mi>`, large: false }
      if (c === '_' || c === '^') return { html: '<mrow></mrow>', large: false }
      return { html: `<mo>${esc(c)}</mo>`, large: false }
    }
    return this.parseCommand(tok.v)
  }

  private parseCommand(name: string): { html: string; large: boolean } | null {
    const plain = (html: string) => ({ html, large: false })
    if (GREEK[name]) return plain(/^[A-Z]/.test(name) ? `<mi mathvariant="normal">${GREEK[name]}</mi>` : `<mi>${GREEK[name]}</mi>`)
    if (OPERATORS[name]) return plain(`<mo>${esc(OPERATORS[name])}</mo>`)
    if (IDENTIFIERS[name]) return plain(`<mi>${IDENTIFIERS[name]}</mi>`)
    if (LARGE[name]) return { html: `<mo largeop="true" movablelimits="true">${LARGE[name]}</mo>`, large: !name.includes('int') }
    if (FUNCTIONS.has(name)) return { html: `<mi mathvariant="normal">${name}</mi><mo>&#x2061;</mo>`, large: LIMIT_FUNCTIONS.has(name) }
    if (SPACES[name]) return plain(`<mspace width="${SPACES[name]}"></mspace>`)
    switch (name) {
      case 'frac': case 'dfrac': case 'tfrac': {
        const num = this.parseArgument()
        const den = this.parseArgument()
        return plain(`<mfrac>${num}${den}</mfrac>`)
      }
      case 'binom': {
        const a = this.parseArgument()
        const b = this.parseArgument()
        return plain(`<mrow><mo>(</mo><mfrac linethickness="0">${a}${b}</mfrac><mo>)</mo></mrow>`)
      }
      case 'sqrt': {
        const index = this.optional()
        const body = this.parseArgument()
        return plain(index ? `<mroot>${body}${index}</mroot>` : `<msqrt>${body}</msqrt>`)
      }
      case 'text': case 'textrm': case 'textit': case 'textbf': case 'mbox':
        return plain(`<mtext>${esc(this.rawArgument())}</mtext>`)
      case 'left': case 'right': case 'big': case 'Big': case 'bigg': case 'Bigg': case 'bigl': case 'bigr': case 'Bigl': case 'Bigr': {
        const t = this.tokens[this.i++]
        if (!t) return null
        const delim = t.t === 'cmd' ? (OPERATORS[t.v] ?? (t.v === '{' || t.v === '}' ? t.v : t.v === '|' ? '‖' : '')) : t.v === '.' ? '' : t.v
        return plain(delim ? `<mo stretchy="true" fence="true">${esc(delim)}</mo>` : '<mrow></mrow>')
      }
      case 'begin': return plain(this.parseEnvironment(this.rawArgument().trim()))
      case 'end': this.rawArgument(); return null
      case '\\': return null
      case '{': return plain('<mo>{</mo>')
      case '}': return plain('<mo>}</mo>')
      case '|': return plain('<mo>‖</mo>')
      case '%': case '#': case '$': case '&': case '_': return plain(`<mo>${esc(name)}</mo>`)
      case 'displaystyle': case 'limits': case 'nolimits': case 'label': case 'nonumber': case 'notag':
        if (name === 'label') this.rawArgument()
        return null
    }
    if (FONTS[name]) {
      const body = name === 'operatorname' ? `<mi>${esc(this.rawArgument())}</mi>` : this.parseArgument()
      return plain(`<mstyle mathvariant="${FONTS[name]}">${body}</mstyle>`.replace(/<mi>/g, `<mi mathvariant="${FONTS[name]}">`))
    }
    if (ACCENTS[name]) {
      const body = this.parseArgument()
      return plain(`<mover accent="true">${body}<mo stretchy="${name.startsWith('wide') || name.startsWith('over') ? 'true' : 'false'}">${esc(ACCENTS[name])}</mo></mover>`)
    }
    if (name === 'underline') return plain(`<munder>${this.parseArgument()}<mo stretchy="true">_</mo></munder>`)
    // Inconnue : visible, en rouge.
    return plain(`<merror><mtext>\\${esc(name)}</mtext></merror>`)
  }

  private parseEnvironment(env: string): string {
    const isStop = (t: Token) => (t.t === 'char' && t.v === '&') || (t.t === 'cmd' && (t.v === '\\' || t.v === 'end'))
    if (env === 'array') this.rawArgument()
    const rows: string[][] = [[]]
    while (this.i < this.tokens.length) {
      const cell = this.parseRow(isStop)
      rows[rows.length - 1].push(cell)
      const tok = this.tokens[this.i]
      if (!tok) break
      this.i++
      if (tok.t === 'char' && tok.v === '&') continue
      if (tok.t === 'cmd' && tok.v === '\\') { rows.push([]); continue }
      if (tok.t === 'cmd' && tok.v === 'end') { this.rawArgument(); break }
      if (tok.t === 'char' && tok.v === '}') continue
    }
    if (rows.length > 1 && rows[rows.length - 1].every(c => c === '<mrow></mrow>')) rows.pop()
    const aligned = env.startsWith('align') || env === 'aligned' || env === 'split'
    const table = `<mtable${aligned ? ' columnalign="right left" columnspacing="0"' : env === 'cases' ? ' columnalign="left left"' : ''}>${rows.map(r => `<mtr>${r.map(c => `<mtd>${c}</mtd>`).join('')}</mtr>`).join('')}</mtable>`
    const [open, close] = MATRICES[env] ?? ['', '']
    if (!open && !close) return table
    return `<mrow>${open ? `<mo fence="true">${esc(open)}</mo>` : ''}${table}${close ? `<mo fence="true">${esc(close)}</mo>` : ''}</mrow>`
  }

  get source(): string { return this.raw }
}

/** Une formule en MathML. `display` : formule centree (equation, \[...\]). */
export function texToMathML(tex: string, display = false): string {
  const parser = new Parser(tokenize(tex), display, tex)
  let row: string
  try {
    row = parser.parseRow()
  } catch {
    row = `<merror><mtext>${esc(tex)}</mtext></merror>`
  }
  return `<math xmlns="http://www.w3.org/1998/Math/MathML"${display ? ' display="block"' : ''}><semantics>${row}<annotation encoding="application/x-tex">${esc(tex)}</annotation></semantics></math>`
}
