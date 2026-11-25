// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le format d'une animation (.anim) : un texte, edite a plusieurs (CRDT),
// dans l'ordre ou le navigateur le lit.
//
//   <style> … </style>                     les styles de la scene
//   <div class="balle"></div>              la scene : HTML et SVG
//   <script type="application/json" id="keyframes"> … </script>
//                                          les images cles (facultatif)
//   <script> … </script>                   le code, avec anime.js v4
//
// Le code trouve `anime` (toute la bibliotheque : animate, createTimeline,
// stagger, svg, utils…) et `timeline`, la frise de l'animation. Savoire la
// lit, la met en pause et la deplace au timecode : tout ce qui doit se voir
// dans la lecture et les commentaires s'y ajoute (timeline.add, .sync).
//
// Images cles en JSON : { "tracks": [ { "target": ".balle", "at": 0,
// "keyframes": [ { "x": 240, "duration": 800 }, { "y": 80 } ], "ease": "outQuad" } ] }
// Chaque piste s'ajoute a la frise (timeline.add(target, params, at)). C'est
// la forme qu'ecrira un editeur visuel par images cles, et celle que l'IA
// peut regler sans toucher au code.
//
// Logique pure : partagee par la vue, l'integration et les outils d'agent
// (qui tournent aussi sur le pair indexeur, sans page).

export const ANIM_EXTENSION = 'anim'

export interface AnimParts {
  /** Styles de la scene (sans la balise <style>). */
  css: string
  /** La scene : HTML et SVG. */
  html: string
  /** Images cles ({ tracks: [...] }), ou null. */
  keyframes: unknown
  /** Le code (sans la balise <script>). */
  script: string
}

const HEADER = `<!-- Animation Savoire : la scène (HTML, SVG, CSS), puis le code.
     anime.js v4 est chargé : « anime » (animate, createTimeline, stagger, svg, utils…).
     « timeline » est la frise de l'animation : lecture, pause et timecode passent par elle. -->`

const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/i
const KEYFRAMES_RE = /<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i
const SCRIPT_RE = /<script\b(?![^>]*\btype\s*=\s*["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi
const COMMENT_RE = /^\s*<!--[\s\S]*?-->\s*/

const indent = (s: string) => s.replace(/^\n+|\s+$/g, '')

/** Le texte d'une animation, a partir de ses parties. */
export function composeAnimation(parts: Partial<AnimParts>): string {
  const out = [HEADER]
  const css = indent(parts.css ?? '')
  if (css) out.push(`<style>\n${css}\n</style>`)
  const html = indent(parts.html ?? '')
  if (html) out.push(html)
  if (parts.keyframes !== undefined && parts.keyframes !== null) {
    out.push(`<script type="application/json" id="keyframes">\n${JSON.stringify(parts.keyframes, null, 2).replace(/<\//g, '<\\/')}\n</script>`)
  }
  // Un « </script> » dans le code fermerait sa balise (c'est du HTML) : « <\/script> » vaut la meme chose en JavaScript.
  const script = indent(parts.script ?? '').replace(/<\/(script)/gi, '<\\/$1')
  if (script) out.push(`<script>\n${script}\n</script>`)
  return `${out.join('\n\n')}\n`
}

/** Les parties d'une animation (lecture tolerante : un texte libre reste la scene). */
export function animationParts(source: string): AnimParts {
  let rest = source.replace(COMMENT_RE, '')
  const style = STYLE_RE.exec(rest)
  const css = style ? style[1]!.trim() : ''
  if (style) rest = rest.replace(style[0], '')
  const kf = KEYFRAMES_RE.exec(rest)
  let keyframes: unknown = null
  if (kf) {
    rest = rest.replace(kf[0], '')
    try { keyframes = JSON.parse(kf[1]!.trim() || 'null') } catch { keyframes = kf[1]!.trim() }
  }
  const scripts: string[] = []
  rest = rest.replace(SCRIPT_RE, (_m, code: string) => { scripts.push(code.trim()); return '' })
  return { css, html: rest.trim(), keyframes, script: scripts.join('\n\n') }
}

/** Remplace les parties donnees, garde les autres. */
export function replaceParts(source: string, parts: Partial<AnimParts>): string {
  const current = animationParts(source)
  return composeAnimation({
    css: parts.css ?? current.css,
    html: parts.html ?? current.html,
    keyframes: parts.keyframes !== undefined ? parts.keyframes : current.keyframes,
    script: parts.script ?? current.script,
  })
}

/** Les images cles sont-elles lisibles ? Rend un message d'erreur, ou null. */
export function checkKeyframes(k: unknown): string | null {
  if (k === null || k === undefined) return null
  if (typeof k !== 'object' || Array.isArray(k)) return 'Les images clés sont un objet { "tracks": [...] }.'
  const tracks = (k as { tracks?: unknown }).tracks
  if (tracks === undefined) return null
  if (!Array.isArray(tracks)) return '« tracks » est une liste de pistes.'
  for (const [i, t] of tracks.entries()) {
    if (!t || typeof t !== 'object') return `Piste ${i + 1} : un objet attendu.`
    const target = (t as { target?: unknown }).target
    if (typeof target !== 'string' || !target.trim()) return `Piste ${i + 1} : « target » (sélecteur CSS) attendu.`
  }
  return null
}

/** Une animation d'exemple : une balle qui rebondit, un titre qui apparait. */
export const ANIM_TEMPLATE = composeAnimation({
  css: `.scene { position: relative; height: 220px; overflow: hidden; font-family: var(--font-ui, system-ui, sans-serif); }
.balle { position: absolute; left: 24px; top: 24px; width: 48px; height: 48px; border-radius: 50%; background: var(--accent, #7c3aed); }
.titre { position: absolute; left: 24px; bottom: 24px; font-size: 28px; font-weight: 700; color: var(--heading-color, var(--text, #1e1e2e)); opacity: 0; }`,
  html: `<div class="scene">
  <div class="balle"></div>
  <div class="titre">Bonjour !</div>
</div>`,
  keyframes: {
    tracks: [
      { target: '.balle', at: 0, keyframes: [{ x: 260, y: 120, duration: 700 }, { x: 520, y: 0, duration: 700 }], ease: 'inOutQuad' },
    ],
  },
  script: `const { stagger } = anime

// La frise : les images clés ci-dessus y sont déjà, ajoutez la suite.
timeline
  .add('.titre', { opacity: [0, 1], y: [20, 0], duration: 600, ease: 'outCubic' }, 900)
  .add('.balle', { scale: [1, 1.4, 1], duration: 500 }, 1500)`,
})

// ── Timecodes ───────────────────────────────────────────────────────────

/** 1250 -> « 0:01.25 ». */
export function formatTimecode(ms: number): string {
  const t = Math.max(0, Math.round(Number.isFinite(ms) ? ms : 0))
  const m = Math.floor(t / 60000)
  const s = Math.floor((t % 60000) / 1000)
  const cs = Math.floor((t % 1000) / 10)
  return `${m}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

/** « 0:01.25 », « 1.25 » (secondes), « 1250ms » -> 1250. Null si illisible. */
export function parseTimecode(s: unknown): number | null {
  if (typeof s === 'number') return Number.isFinite(s) && s >= 0 ? Math.round(s) : null
  if (typeof s !== 'string') return null
  const t = s.trim().replace(',', '.')
  let m = /^(\d+(?:\.\d+)?)\s*ms$/i.exec(t)
  if (m) return Math.round(Number(m[1]))
  m = /^(\d+(?:\.\d+)?)\s*s?$/i.exec(t)
  if (m) return Math.round(Number(m[1]) * 1000)
  m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(t)
  if (m) return Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000)
  return null
}

// ── Integration ![[x.anim]] ─────────────────────────────────────────────

export const ANIM_EMBED_RE = /^\s*!\[\[([^\]|#]+\.anim)(?:\|([^\]]*))?\]\]\s*$/i

export interface AnimEmbed {
  name: string
  /** Rejouer en boucle. */
  loop: boolean
  /** Demarrer seul (sinon a la demande). */
  autoplay: boolean
  /** Sans barre de lecture (une diapositive, une page). */
  controls: boolean
}

/**
 * ![[Intro.anim]], ![[Intro.anim|boucle]], ![[Intro.anim|pause]],
 * ![[Intro.anim|boucle sans-barre]]. Les mots se combinent.
 */
export function parseAnimEmbed(text: string): AnimEmbed | null {
  const m = ANIM_EMBED_RE.exec(text)
  if (!m) return null
  const words = new Set((m[2] ?? '').toLowerCase().split(/[\s,;]+/).filter(Boolean))
  const has = (...w: string[]) => w.some(x => words.has(x))
  return {
    name: m[1]!.trim(),
    loop: has('boucle', 'loop'),
    autoplay: !has('pause', 'manuel', 'paused', 'manual'),
    controls: !has('sans-barre', 'nocontrols', 'épuré', 'epure'),
  }
}

export function animEmbedText(name: string, options: { loop?: boolean; autoplay?: boolean; controls?: boolean } = {}): string {
  const words = [options.loop ? 'boucle' : '', options.autoplay === false ? 'pause' : '', options.controls === false ? 'sans-barre' : ''].filter(Boolean)
  return `![[${name}${words.length ? `|${words.join(' ')}` : ''}]]`
}

// ── Commentaires au timecode (Revision) ─────────────────────────────────

/** Ce que vise un commentaire d'animation (ReviewAPI.comment, target). */
export interface AnimCommentTarget {
  kind: 'anim.time'
  /** Debut, en ms. */
  start: number
  /** Fin d'une plage, en ms (absent : un instant). */
  end?: number
  /** Element vise a cet instant (selecteur CSS dans la scene). */
  element?: string
  /** Nom lisible de l'element (« div.balle »). */
  elementLabel?: string
}

export function isAnimTarget(t: unknown): t is AnimCommentTarget {
  return !!t && typeof t === 'object' && (t as { kind?: unknown }).kind === 'anim.time' && typeof (t as { start?: unknown }).start === 'number'
}

/** « À 0:01.25 », « De 0:01.00 à 0:02.50 », avec l'element. */
export function describeTarget(t: AnimCommentTarget): string {
  const when = t.end !== undefined && t.end > t.start ? `De ${formatTimecode(t.start)} à ${formatTimecode(t.end)}` : `À ${formatTimecode(t.start)}`
  return t.elementLabel || t.element ? `${when} · ${t.elementLabel || t.element}` : when
}
