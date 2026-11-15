// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Nettoyage du HTML avant de l'afficher.
//
// Le texte d'une note vient des autres membres du vault, ou d'un lien de
// partage en ecriture : il n'est pas de confiance. Markdown laisse passer le
// HTML brut ; l'afficher tel quel (innerHTML) ferait tourner le script d'un
// autre dans la session de la personne (vol de sa session).
//
// TOUT HTML qui vient d'une note passe donc par sanitizeHtml avant innerHTML.
// Le HTML reste affiche (comme dans Obsidian : <br>, <details>, couleurs,
// tableaux...), sans ce qui s'execute ni ce qui trompe :
//  - pas de script, d'attribut on*, d'adresse javascript: ;
//  - pas de <style> (il redessinerait toute l'application) ;
//  - pas de formulaire ni de champ de saisie (faux ecran de connexion), sauf
//    les cases a cocher des listes de taches ;
//  - pas de cadre ni d'objet embarque ;
//  - un lien qui ouvre un autre onglet ne garde pas la main sur celui-ci.
//
// Dans un navigateur : DOMPurify. Il est verifie au demarrage sur une charge
// connue (autocontrole) : certains DOM simules (happy-dom, dans les tests) le
// font passer a cote de presque tout, sans erreur. Si l'autocontrole echoue,
// un nettoyage plus strict, par liste blanche, prend le relais. Sans DOM du
// tout (pair indexeur), rien n'est affiche : le HTML est rendu en texte.
import createDOMPurify from 'dompurify'

type Purifier = ReturnType<typeof createDOMPurify>

const FORBID_TAGS = ['style', 'form', 'textarea', 'select', 'option', 'button', 'iframe', 'frame', 'object', 'embed', 'base', 'link', 'meta', 'dialog']
const FORBID_ATTR = ['formaction', 'form', 'action', 'ping', 'autofocus', 'popover', 'popovertarget', 'popovertargetaction']

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

// ── Navigateur : DOMPurify ──────────────────────────────────────────────────

function purify(p: Purifier, html: string): string {
  return p.sanitize(html, { FORBID_TAGS, FORBID_ATTR, ADD_ATTR: ['target'] }) as string
}

function createPurifier(): Purifier | null {
  // Une instance a nous : ses regles ne touchent pas celle d'une bibliotheque (Mermaid).
  const p = createDOMPurify(window)
  if (!p.isSupported) return null
  p.addHook('uponSanitizeElement', (node, data) => {
    // Seules les cases a cocher (listes de taches) restent.
    if (data.tagName === 'input' && (node as Element).getAttribute?.('type')?.toLowerCase() !== 'checkbox') {
      ;(node as Element).remove()
    }
  })
  p.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName === 'A' && node.hasAttribute('target')) node.setAttribute('rel', 'noopener noreferrer')
    // Une case a cocher venue d'une note ne s'envoie nulle part.
    if (node.nodeName === 'INPUT') { node.removeAttribute('name'); node.removeAttribute('value') }
  })
  // Autocontrole : ce qui doit partir part, ce qui doit rester reste.
  const out = purify(p, '<h2>t</h2><p>a</p><script>1</script><img src="x" onerror="1"><a href="javascript:1">b</a><iframe></iframe>').toLowerCase()
  const ok = out.includes('<h2>t</h2>') && out.includes('<p>a</p>') && out.includes('<img')
    && !/script|onerror|javascript|iframe/.test(out)
  return ok ? p : null
}

// ── Repli : liste blanche stricte, par parcours du DOM ──────────────────────

const ALLOWED_TAGS = new Set((
  'a abbr b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl dt em '
  + 'figcaption figure font h1 h2 h3 h4 h5 h6 hr i img input ins kbd li mark ol p pre q s samp section small span '
  + 'strike strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr'
).split(' '))
// Retires avec leur contenu ; les autres balises inconnues ne gardent que leur contenu.
const DROPPED_TAGS = new Set((
  'script style iframe frame frameset object embed template noscript textarea select option button title head '
  + 'svg math form link meta base dialog audio video source track canvas applet'
).split(' '))
const ALLOWED_ATTR = new Set((
  'align alt checked cite class colspan datetime dir disabled height href id lang open rel reversed rowspan '
  + 'scope span src start style target title type valign width'
).split(' '))
const SAFE_URL = /^(?:https?:|mailto:|tel:|#|\/|\.{1,2}\/|[^:]*$)/i
const SAFE_IMAGE_URL = /^(?:data:image\/(?:png|jpe?g|gif|webp|avif);|blob:)/i

function cleanNode(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) continue                         // texte
    if (child.nodeType !== 1) { child.parentNode?.removeChild(child); continue }  // commentaires...
    const el = child as Element
    const tag = el.tagName.toLowerCase()
    const isCheckbox = tag === 'input' && el.getAttribute('type')?.toLowerCase() === 'checkbox'
    if (DROPPED_TAGS.has(tag) || (tag === 'input' && !isCheckbox)) { el.parentNode?.removeChild(el); continue }
    cleanNode(el)
    if (!ALLOWED_TAGS.has(tag)) {
      // Balise inconnue : son contenu (deja nettoye) prend sa place.
      while (el.firstChild) el.parentNode?.insertBefore(el.firstChild, el)
      el.parentNode?.removeChild(el)
      continue
    }
    for (const name of el.getAttributeNames()) {
      const lower = name.toLowerCase()
      const value = el.getAttribute(name) ?? ''
      const url = value.replace(/[\u0000- ]/g, '')
      const keep = lower.startsWith('data-')
        || (ALLOWED_ATTR.has(lower) && (
          lower === 'href' ? SAFE_URL.test(url)
          : lower === 'src' ? SAFE_URL.test(url) || (tag === 'img' && SAFE_IMAGE_URL.test(url))
          : lower === 'style' ? !/url\s*\(|expression|@import|javascript:/i.test(value)
          : true))
      if (!keep) el.removeAttribute(name)
    }
    if (tag === 'a' && el.hasAttribute('target')) el.setAttribute('rel', 'noopener noreferrer')
  }
}

function strictSanitize(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  const content = (template as HTMLTemplateElement).content
  if (!content) return escapeHtml(html)
  cleanNode(content)
  const holder = document.createElement('div')
  holder.appendChild(content)
  return holder.innerHTML
}

// ── Entree ─────────────────────────────────────────────────────────────────

type Engine = (html: string) => string
let engine: Engine | undefined

function resolveEngine(): Engine {
  if (typeof window === 'undefined' || typeof document === 'undefined') return escapeHtml
  let purifier: Purifier | null = null
  try { purifier = createPurifier() } catch { purifier = null }
  if (purifier) { const p = purifier; return html => purify(p, html) }
  return html => { try { return strictSanitize(html) } catch { return escapeHtml(html) } }
}

/**
 * Le HTML sans rien qui s'execute. A appeler sur tout HTML issu d'une note
 * (rendu Markdown compris) avant de l'inserer dans la page.
 */
export function sanitizeHtml(html: string): string {
  if (!html) return ''
  engine ??= resolveEngine()
  return engine(html)
}

/** Quel nettoyage sert ici : 'dompurify' (navigateur), 'strict' (repli), 'text' (sans DOM). Pour les tests. */
export function sanitizerKind(): 'dompurify' | 'strict' | 'text' {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 'text'
  try { return createPurifier() ? 'dompurify' : 'strict' } catch { return 'strict' }
}

/** Insere dans `el` du HTML issu d'une note, nettoye. */
export function setSanitizedHtml(el: Element, html: string): void {
  el.innerHTML = sanitizeHtml(html)
}
