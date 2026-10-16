// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Syntaxes propres a Plume (l'editeur Markdown), compatibles Obsidian :
//
//  Surlignage : ==texte==        couleur du theme
//               ==🔴texte==      rouge : un emoji de couleur juste apres ==
//               (comme Obsidian ; ailleurs, on lit simplement l'emoji)
//
//  Couleur du texte : `🔴` en debut de ligne (apres la puce, le # ou le >)
//               colore la ligne. L'emoji est entre backticks pour qu'une
//               ligne qui commence par un emoji ordinaire ne change pas.
//
// Les six couleurs sont celles d'Obsidian.
import { marked, type Tokens, type TokenizerAndRendererExtension, type MarkedExtension } from 'marked'

export type PlumeColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple'

export const PLUME_COLORS: ReadonlyArray<{ color: PlumeColor; emoji: string; label: string }> = [
  { color: 'red',    emoji: '🔴', label: 'Rouge' },
  { color: 'orange', emoji: '🟠', label: 'Orange' },
  { color: 'yellow', emoji: '🟡', label: 'Jaune' },
  { color: 'green',  emoji: '🟢', label: 'Vert' },
  { color: 'blue',   emoji: '🔵', label: 'Bleu' },
  { color: 'purple', emoji: '🟣', label: 'Violet' },
]

const BY_EMOJI = new Map(PLUME_COLORS.map(c => [c.emoji, c.color]))
const EMOJI_OF = new Map(PLUME_COLORS.map(c => [c.color, c.emoji]))

export function colorOfEmoji(emoji: string): PlumeColor | undefined {
  return BY_EMOJI.get(emoji)
}

export function emojiOf(color: PlumeColor): string {
  return EMOJI_OF.get(color)!
}

/** Alternance des six emojis, pour les expressions regulieres. */
export const COLOR_EMOJI_SOURCE = PLUME_COLORS.map(c => c.emoji).join('|')

// ── Surlignage ──────────────────────────────────────────────────────────────

interface HighlightToken extends Tokens.Generic {
  type: 'plumeHighlight'
  color?: PlumeColor
  tokens: Tokens.Generic[]
}

const HIGHLIGHT_RE = new RegExp(`^==(?!=)(${COLOR_EMOJI_SOURCE})?([^\\n]*?[^\\s=]|)==(?!=)`, 'u')

const highlight: TokenizerAndRendererExtension = {
  name: 'plumeHighlight',
  level: 'inline',
  start(src: string) {
    const i = src.indexOf('==')
    return i < 0 ? undefined : i
  },
  tokenizer(src: string) {
    const m = HIGHLIGHT_RE.exec(src)
    if (!m) return undefined
    const color = m[1] ? colorOfEmoji(m[1]) : undefined
    const inner = m[2]
    if (!inner && !color) return undefined
    return {
      type: 'plumeHighlight',
      raw: m[0],
      color,
      tokens: this.lexer.inlineTokens(inner),
    } satisfies HighlightToken
  },
  renderer(token) {
    const t = token as HighlightToken
    const cls = t.color ? `plume-hl plume-hl-${t.color}` : 'plume-hl'
    return `<mark class="${cls}">${this.parser.parseInline(t.tokens)}</mark>`
  },
}

// ── Couleur de ligne ────────────────────────────────────────────────────────

interface LineColorToken extends Tokens.Generic {
  type: 'plumeLineColor'
  color: PlumeColor
  tokens: Tokens.Generic[]
}

function endsLine(t: Tokens.Generic | undefined): boolean {
  return t === undefined || t.type === 'br' || (t.type === 'text' && /\n$/.test(t.raw))
}

/**
 * Regroupe ce qui suit un `🔴` place en debut de ligne, jusqu'a la fin de la
 * ligne, dans un jeton de couleur.
 */
function groupLineColors(tokens: Tokens.Generic[]): Tokens.Generic[] {
  const out: Tokens.Generic[] = []
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    const color = t.type === 'codespan' ? colorOfEmoji((t as Tokens.Codespan).text) : undefined
    if (!color || !endsLine(out[out.length - 1])) { out.push(t); i++; continue }
    const body: Tokens.Generic[] = []
    i++
    while (i < tokens.length && tokens[i].type !== 'br') {
      const cur = tokens[i]
      // Un texte qui contient un retour a la ligne : la couleur s'arrete la.
      if (cur.type === 'text' && cur.raw.includes('\n')) {
        const cut = cur.raw.indexOf('\n')
        const head = cur.raw.slice(0, cut)
        if (head) body.push({ type: 'text', raw: head, text: head })
        tokens.splice(i, 1, { type: 'text', raw: cur.raw.slice(cut), text: cur.raw.slice(cut) })
        break
      }
      body.push(cur)
      i++
    }
    // L'espace entre l'emoji et le texte n'est pas du contenu.
    const first = body[0]
    if (first?.type === 'text') {
      const raw = first.raw.replace(/^ /, '')
      body[0] = { ...first, raw, text: (first as Tokens.Text).text.replace(/^ /, '') }
    }
    out.push({ type: 'plumeLineColor', raw: '', color, tokens: body } satisfies LineColorToken)
  }
  return out
}

const lineColor: TokenizerAndRendererExtension = {
  name: 'plumeLineColor',
  level: 'inline',
  renderer(token) {
    const t = token as LineColorToken
    return `<span class="plume-color plume-color-${t.color}">${this.parser.parseInline(t.tokens)}</span>`
  },
}

export const plumeMarkedExtension: MarkedExtension = {
  extensions: [highlight, lineColor],
  walkTokens(token) {
    const t = token as Tokens.Generic
    if (t.type !== 'plumeLineColor' && Array.isArray(t.tokens)) t.tokens = groupLineColors(t.tokens)
  },
}

// Branchee une fois sur l'instance partagee de marked : les plugins qui
// rendent du Markdown avec marked (listes, notes integrees...) en profitent.
let installed = false
export function installPlumeMarkdown(): void {
  if (installed) return
  installed = true
  marked.use(plumeMarkedExtension)
}
installPlumeMarkdown()

// ── Styles ──────────────────────────────────────────────────────────────────

/** Couleurs : surlignage (fond) et texte, lisibles en theme clair et sombre. */
export const PLUME_COLOR_VALUES: Record<PlumeColor, { highlight: string; text: string }> = {
  red:    { highlight: 'rgba(233, 49, 71, 0.35)',  text: '#e5484d' },
  orange: { highlight: 'rgba(236, 117, 0, 0.35)',  text: '#ef7d1a' },
  yellow: { highlight: 'rgba(224, 172, 0, 0.40)',  text: '#c9a100' },
  green:  { highlight: 'rgba(8, 185, 78, 0.35)',   text: '#2fb35e' },
  blue:   { highlight: 'rgba(8, 109, 221, 0.35)',  text: '#3b8cf0' },
  purple: { highlight: 'rgba(120, 82, 238, 0.35)', text: '#9b7bf2' },
}

/** Regles de style (format EditorView.theme) des syntaxes Plume. */
export function plumeColorTheme(): Record<string, Record<string, string>> {
  const rules: Record<string, Record<string, string>> = {
    '.plume-hl': {
      background: 'var(--text-highlight-bg, rgba(255, 208, 0, 0.4))',
      color: 'inherit',
      borderRadius: '2px',
      padding: '0 1px',
    },
  }
  for (const { color } of PLUME_COLORS) {
    rules[`.plume-hl-${color}`] = { background: PLUME_COLOR_VALUES[color].highlight }
    rules[`.plume-color-${color}`] = { color: PLUME_COLOR_VALUES[color].text }
  }
  return rules
}
