// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Apercu d'un document LaTeX, sans moteur TeX : une traduction en HTML des
// commandes courantes, les formules en MathML (math.ts).
//
// Ce n'est pas une compilation : pas de mise en page au point pres, pas de
// paquets, pas de macros (\newcommand). C'est un apercu fidele au contenu,
// qui se met a jour a chaque frappe, chez chaque membre. Ce qui n'est pas
// reconnu reste visible (en gris), jamais efface.

import { texToMathML } from './math'

export interface RenderResult {
  html: string
  /** Commandes non reconnues (pour l'indiquer a la personne). */
  unknown: string[]
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Retire les commentaires (% jusqu'a la fin de ligne, sauf \%). */
export function stripComments(src: string): string {
  return src.split('\n').map(line => {
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') { i++; continue }
      if (line[i] === '%') return line.slice(0, i)
    }
    return line
  }).join('\n')
}

/** Lit un groupe {…} equilibre a partir de `i` (sur l'accolade). Rend le contenu et la fin. */
function group(src: string, i: number): { body: string; end: number } | null {
  while (src[i] === ' ' || src[i] === '\n') i++
  if (src[i] !== '{') return null
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue }
    if (src[j] === '{') depth++
    else if (src[j] === '}' && --depth === 0) return { body: src.slice(i + 1, j), end: j + 1 }
  }
  return { body: src.slice(i + 1), end: src.length }
}

/** Argument optionnel […] a partir de `i`. */
function optionalArg(src: string, i: number): { body: string; end: number } | null {
  if (src[i] !== '[') return null
  let depth = 0
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') depth--
    else if (src[j] === ']' && depth === 0) return { body: src.slice(i + 1, j), end: j + 1 }
  }
  return null
}

/** Trouve le \end{env} qui ferme le \begin{env} (imbrications comprises). */
function findEnd(src: string, from: number, env: string): { body: string; end: number } {
  const open = `\\begin{${env}}`
  const close = `\\end{${env}}`
  let depth = 1
  let i = from
  while (i < src.length) {
    const a = src.indexOf(open, i)
    const b = src.indexOf(close, i)
    if (b < 0) return { body: src.slice(from), end: src.length }
    if (a >= 0 && a < b) { depth++; i = a + open.length; continue }
    if (--depth === 0) return { body: src.slice(from, b), end: b + close.length }
    i = b + close.length
  }
  return { body: src.slice(from), end: src.length }
}

/** Decoupe au niveau 0 (hors accolades et environnements imbriques). */
function splitTop(src: string, sep: RegExp): string[] {
  const parts: string[] = []
  let depth = 0
  let envDepth = 0
  let last = 0
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      if (src.startsWith('\\begin{', i)) envDepth++
      else if (src.startsWith('\\end{', i)) envDepth--
      else if (depth === 0 && envDepth === 0) {
        sep.lastIndex = i
        const m = sep.exec(src)
        if (m && m.index === i) { parts.push(src.slice(last, i)); last = i + m[0].length; i = last - 1; continue }
      }
      i++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (depth === 0 && envDepth === 0 && c === '&' && sep.source === '&') { parts.push(src.slice(last, i)); last = i + 1 }
  }
  parts.push(src.slice(last))
  return parts
}

const SECTION_LEVELS: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 }
const THEOREMS: Record<string, string> = {
  theorem: 'Théorème', lemma: 'Lemme', proposition: 'Proposition', corollary: 'Corollaire', definition: 'Définition',
  remark: 'Remarque', example: 'Exemple', proof: 'Démonstration', exercise: 'Exercice', note: 'Note',
}
const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'displaymath', 'eqnarray', 'eqnarray*', 'math'])

class Renderer {
  private readonly counters = [0, 0, 0, 0, 0, 0]
  private equation = 0
  private figure = 0
  private readonly labels = new Map<string, string>()
  private lastNumber = ''
  private readonly footnotes: string[] = []
  readonly unknown = new Set<string>()
  meta: { title?: string; author?: string; date?: string } = {}

  document(src: string): string {
    const text = stripComments(src)
    for (const key of ['title', 'author', 'date'] as const) {
      const at = text.search(new RegExp(`\\\\${key}\\s*\\{`))
      if (at >= 0) this.meta[key] = group(text, text.indexOf('{', at))?.body
    }
    const start = text.indexOf('\\begin{document}')
    const body = start >= 0 ? findEnd(text, start + '\\begin{document}'.length, 'document').body : this.dropPreamble(text)
    let html = this.blocks(body)
    if (this.footnotes.length) {
      html += `<hr class="tex-footrule"><ol class="tex-footnotes">${this.footnotes.map((f, i) => `<li id="tex-fn-${i + 1}">${f}</li>`).join('')}</ol>`
    }
    // Renvois : remplaces une fois tous les numeros connus.
    return html.replace(/\u0000ref:([^\u0000]*)\u0000/g, (_, key: string) => esc(this.labels.get(key) ?? '??'))
  }

  /** Sans \begin{document} : les lignes de preambule sont ignorees. */
  private dropPreamble(text: string): string {
    return text.replace(/^\s*\\(documentclass|usepackage|title|author|date|newcommand|renewcommand|setlength|geometry)\b(\[[^\]]*\])?(\{[^}]*\})*\s*$/gm, '')
  }

  blocks(src: string): string {
    const out: string[] = []
    let para = ''
    const flush = () => {
      const t = para.trim()
      if (t) out.push(`<p>${this.inline(t)}</p>`)
      para = ''
    }
    let i = 0
    while (i < src.length) {
      // Ligne vide : fin de paragraphe.
      const blank = /^\n[ \t]*\n/.exec(src.slice(i, i + 200))
      if (blank) { flush(); i += blank[0].length; continue }
      if (src.startsWith('\\[', i)) {
        flush()
        const end = src.indexOf('\\]', i + 2)
        const tex = src.slice(i + 2, end < 0 ? src.length : end)
        out.push(`<div class="tex-display">${texToMathML(tex, true)}</div>`)
        i = end < 0 ? src.length : end + 2
        continue
      }
      if (src.startsWith('$$', i)) {
        flush()
        const end = src.indexOf('$$', i + 2)
        const tex = src.slice(i + 2, end < 0 ? src.length : end)
        out.push(`<div class="tex-display">${texToMathML(tex, true)}</div>`)
        i = end < 0 ? src.length : end + 2
        continue
      }
      if (src[i] === '\\') {
        const m = /^\\([A-Za-z]+\*?)/.exec(src.slice(i, i + 40))
        const name = m?.[1] ?? ''
        if (name === 'begin') {
          const env = group(src, i + 6)
          if (env) {
            flush()
            const { body, end } = findEnd(src, env.end, env.body)
            out.push(this.environment(env.body.trim(), body))
            i = end
            continue
          }
        }
        const level = SECTION_LEVELS[name.replace('*', '')]
        if (level !== undefined) {
          const opt = optionalArg(src, i + name.length + 1)
          const title = group(src, opt ? opt.end : i + name.length + 1)
          if (title) {
            flush()
            out.push(this.heading(level, title.body, !name.endsWith('*')))
            i = title.end
            continue
          }
        }
        if (name === 'maketitle') {
          flush()
          out.push(this.titleBlock())
          i += name.length + 1
          continue
        }
        if (name === 'tableofcontents' || name === 'newpage' || name === 'clearpage' || name === 'bigskip' || name === 'medskip' || name === 'smallskip' || name === 'noindent' || name === 'centering' || name === 'vfill') {
          i += name.length + 1
          continue
        }
        if (name === 'label') {
          const g = group(src, i + 6)
          if (g) { this.labels.set(g.body.trim(), this.lastNumber); i = g.end; continue }
        }
      }
      // Une commande passe entiere (\\[2pt] n'est pas une formule).
      if (src[i] === '\\') { para += src.slice(i, i + 2); i += 2; continue }
      para += src[i]
      i++
    }
    flush()
    return out.join('\n')
  }

  private heading(level: number, title: string, numbered: boolean): string {
    let number = ''
    if (numbered && level >= 1 && level <= 3) {
      this.counters[level]++
      for (let k = level + 1; k < this.counters.length; k++) this.counters[k] = 0
      number = this.counters.slice(1, level + 1).join('.')
      this.lastNumber = number
    }
    const tag = `h${Math.min(6, level + 1)}`
    return `<${tag} class="tex-h tex-h${level}">${number ? `<span class="tex-num">${number}</span>` : ''}${this.inline(title)}</${tag}>`
  }

  private titleBlock(): string {
    const { title, author, date } = this.meta
    return `<header class="tex-titleblock">${title ? `<h1 class="tex-title">${this.inline(title)}</h1>` : ''}${author ? `<div class="tex-author">${this.inline(author.replace(/\\and/g, ', '))}</div>` : ''}${date !== undefined ? `<div class="tex-date">${this.inline(date)}</div>` : ''}</header>`
  }

  private environment(env: string, body: string): string {
    if (env === 'itemize' || env === 'enumerate' || env === 'description') {
      const items = splitTop(body, /\\item\b/g).slice(1)
      const tag = env === 'enumerate' ? 'ol' : env === 'description' ? 'dl' : 'ul'
      if (env === 'description') {
        return `<dl class="tex-list">${items.map(it => {
          const opt = optionalArg(it.trimStart(), 0)
          const rest = opt ? it.trimStart().slice(opt.end) : it
          return `<dt>${this.inline(opt?.body ?? '')}</dt><dd>${this.blocks(rest)}</dd>`
        }).join('')}</dl>`
      }
      return `<${tag} class="tex-list">${items.map(it => {
        const opt = optionalArg(it.trimStart(), 0)
        const rest = opt ? it.trimStart().slice(opt.end) : it
        return `<li${opt ? ` data-label="${esc(opt.body)}"` : ''}>${this.blocks(rest).replace(/^<p>([\s\S]*)<\/p>$/, '$1')}</li>`
      }).join('')}</${tag}>`
    }
    if (MATH_ENVS.has(env)) {
      const numbered = !env.endsWith('*') && env !== 'displaymath' && env !== 'math'
      let number = ''
      if (numbered) { this.equation++; number = String(this.equation); this.lastNumber = number }
      // Les \label de la formule visent son numero.
      const tex = body.replace(/\\label\{([^}]*)\}/g, (_, key: string) => { this.labels.set(key.trim(), number); return '' })
      const inner = env.startsWith('align') || env.startsWith('eqnarray') ? `\\begin{aligned}${tex}\\end{aligned}`
        : env.startsWith('gather') || env.startsWith('multline') ? `\\begin{gathered}${tex}\\end{gathered}` : tex
      return `<div class="tex-display">${texToMathML(inner, true)}${number ? `<span class="tex-eqnum">(${number})</span>` : ''}</div>`
    }
    if (env === 'verbatim' || env === 'lstlisting' || env === 'minted') {
      return `<pre class="tex-verbatim">${esc(body.replace(/^\n/, ''))}</pre>`
    }
    if (env === 'quote' || env === 'quotation') return `<blockquote class="tex-quote">${this.blocks(body)}</blockquote>`
    if (env === 'center' || env === 'flushleft' || env === 'flushright') return `<div class="tex-${env}">${this.blocks(body)}</div>`
    if (env === 'abstract') return `<section class="tex-abstract"><div class="tex-abstract-title">Résumé</div>${this.blocks(body)}</section>`
    if (env === 'tabular' || env === 'tabular*' || env === 'array') return this.tabular(body)
    if (env === 'figure' || env === 'figure*' || env === 'table' || env === 'table*') {
      const isTable = env.startsWith('table')
      this.figure++
      this.lastNumber = String(this.figure)
      let caption = ''
      const at = body.search(/\\caption\s*\{/)
      let rest = body
      if (at >= 0) {
        const g = group(body, body.indexOf('{', at))!
        caption = g.body
        rest = body.slice(0, at) + body.slice(g.end)
      }
      rest = rest.replace(/^\s*\[[^\]]*\]/, '')
      const figcaption = caption ? `<figcaption>${isTable ? 'Tableau' : 'Figure'} ${this.figure} : ${this.inline(caption)}</figcaption>` : ''
      return `<figure class="tex-figure">${isTable ? figcaption : ''}${this.blocks(rest)}${isTable ? '' : figcaption}</figure>`
    }
    if (THEOREMS[env]) {
      const opt = optionalArg(body.trimStart(), 0)
      const rest = opt ? body.trimStart().slice(opt.end) : body
      const label = `${THEOREMS[env]}${opt ? ` (${this.inline(opt.body)})` : ''}.`
      return `<div class="tex-theorem tex-${env}"><span class="tex-theorem-label">${label}</span> ${this.blocks(rest).replace(/^<p>/, '').replace(/<\/p>$/, '')}${env === 'proof' ? ' <span class="tex-qed">∎</span>' : ''}</div>`
    }
    if (env === 'document') return this.blocks(body)
    this.unknown.add(`\\begin{${env}}`)
    return `<div class="tex-env" data-env="${esc(env)}">${this.blocks(body)}</div>`
  }

  private tabular(body: string): string {
    const spec = group(body, 0)
    const rows = splitTop(spec ? body.slice(spec.end) : body, /\\\\/g)
      .map(r => r.replace(/\\(hline|toprule|midrule|bottomrule|cline\{[^}]*\})/g, '').trim())
      .filter(r => r)
    return `<table class="tex-table">${rows.map(r => `<tr>${splitTop(r, /&/g).map(c => `<td>${this.inline(c.trim())}</td>`).join('')}</tr>`).join('')}</table>`
  }

  /** Texte courant : mise en forme, formules en ligne, caracteres speciaux. */
  inline(src: string): string {
    let out = ''
    let i = 0
    while (i < src.length) {
      const c = src[i]
      if (c === '$' || src.startsWith('\\(', i)) {
        const close = c === '$' ? '$' : '\\)'
        const from = i + (c === '$' ? 1 : 2)
        const end = src.indexOf(close, from)
        const tex = src.slice(from, end < 0 ? src.length : end)
        out += texToMathML(tex, false)
        i = end < 0 ? src.length : end + close.length
        continue
      }
      if (c === '\\') {
        const m = /^\\([A-Za-z]+\*?|.)/.exec(src.slice(i))
        if (!m) { i++; continue }
        const name = m[1]
        let j = i + m[0].length
        const arg = () => { const g = group(src, j); if (g) j = g.end; return g?.body ?? '' }
        switch (name) {
          case 'textbf': case 'bfseries': out += `<strong>${this.inline(arg())}</strong>`; break
          case 'textit': case 'emph': case 'itshape': out += `<em>${this.inline(arg())}</em>`; break
          case 'underline': out += `<u>${this.inline(arg())}</u>`; break
          case 'texttt': out += `<code>${this.inline(arg())}</code>`; break
          case 'textsc': out += `<span style="font-variant:small-caps">${this.inline(arg())}</span>`; break
          case 'textsuperscript': out += `<sup>${this.inline(arg())}</sup>`; break
          case 'textsubscript': out += `<sub>${this.inline(arg())}</sub>`; break
          case 'url': { const u = arg(); out += safeLink(u, esc(u)); break }
          case 'href': { const u = arg(); const t = arg(); out += safeLink(u, this.inline(t)); break }
          case 'ref': case 'eqref': { const k = arg().trim(); out += name === 'eqref' ? `(\u0000ref:${k}\u0000)` : `\u0000ref:${k}\u0000`; break }
          case 'cite': { const opt = optionalArg(src, j); if (opt) j = opt.end; out += `[${esc(arg())}${opt ? `, ${esc(opt.body)}` : ''}]`; break }
          case 'footnote': {
            this.footnotes.push(this.inline(arg()))
            const n = this.footnotes.length
            out += `<sup class="tex-fnref"><a href="#tex-fn-${n}">${n}</a></sup>`
            break
          }
          case 'label': { const k = arg().trim(); this.labels.set(k, this.lastNumber); break }
          case 'includegraphics': { const opt = optionalArg(src, j); if (opt) j = opt.end; out += `<span class="tex-figure-file">[image : ${esc(arg())}]</span>`; break }
          case 'LaTeX': out += 'L<sup style="font-size:.7em;margin-left:-.3em">A</sup>T<sub style="margin-left:-.1em">E</sub>X'; break
          case 'TeX': out += 'T<sub style="margin-left:-.1em">E</sub>X'; break
          case 'today': out += esc(new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })); break
          case 'ldots': case 'dots': out += '…'; break
          case 'quad': out += '&emsp;'; break
          case 'qquad': out += '&emsp;&emsp;'; break
          case '\\': case 'newline': case 'linebreak': { const opt = optionalArg(src, j); if (opt) j = opt.end; out += '<br>'; break }
          case ',': case ' ': out += '&thinsp;'; break
          case '%': case '&': case '$': case '#': case '_': case '{': case '}': out += esc(name); break
          case 'textbackslash': out += '\\'; break
          case 'centering': case 'noindent': case 'small': case 'large': case 'Large': case 'footnotesize': case 'normalsize': case 'hfill': break
          default:
            this.unknown.add(`\\${name}`)
            out += `<span class="tex-unknown" title="Commande non reconnue">\\${esc(name)}</span>`
        }
        i = j
        continue
      }
      if (c === '{' || c === '}') { i++; continue }
      if (c === '~') { out += '&nbsp;'; i++; continue }
      if (src.startsWith('---', i)) { out += '—'; i += 3; continue }
      if (src.startsWith('--', i)) { out += '–'; i += 2; continue }
      if (src.startsWith('``', i)) { out += '“'; i += 2; continue }
      if (src.startsWith("''", i)) { out += '”'; i += 2; continue }
      if (c === '\n') { out += ' '; i++; continue }
      out += esc(c)
      i++
    }
    return out
  }
}

/** Lien : seulement http(s) et mailto. */
function safeLink(url: string, html: string): string {
  const u = url.trim()
  if (!/^(https?:|mailto:)/i.test(u)) return html
  return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${html}</a>`
}

export function renderLatex(src: string): RenderResult {
  const r = new Renderer()
  const html = r.document(src)
  return { html, unknown: [...r.unknown] }
}
