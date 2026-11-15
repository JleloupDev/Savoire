// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Le HTML d'une note n'est pas de confiance (revue du 14/11/2026, C2) : rien
// de ce qu'il contient ne doit s'executer chez la personne qui l'ouvre. Le
// HTML utile, lui, reste affiche.
//
// Ici, le DOM est simule (happy-dom) : DOMPurify n'y est pas fiable, son
// autocontrole echoue et le nettoyage strict prend le relais. Le chemin du
// navigateur (DOMPurify) est verifie dans sanitize.browser.test.ts.
import { describe, it, expect } from 'vitest'
import { marked } from 'marked'
import { sanitizeHtml, sanitizerKind } from '@savoire/plugin-api'
import { renderNoteForPrint } from '../../../../../packages/editor-core/src/PdfExport'

/** Ce que le navigateur construirait a partir du HTML nettoye. */
function dom(html: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = sanitizeHtml(html)
  return div
}

const hasHandler = (root: Element): boolean =>
  [root, ...Array.from(root.querySelectorAll('*'))].some(el => el.getAttributeNames().some((n: string) => n.toLowerCase().startsWith('on')))

describe('sanitizeHtml : rien ne s execute', () => {
  it('un DOM ou DOMPurify n est pas fiable passe au nettoyage strict', () => {
    expect(sanitizerKind()).toBe('strict')
  })

  it.each([
    ['image piegee', '<img src=x onerror="window.__xss=1">'],
    ['script', '<script>window.__xss=1</script>'],
    ['script apres du texte', '<p>ok</p><script>window.__xss=1</script>'],
    ['svg', '<svg onload="window.__xss=1"><script>window.__xss=1</script></svg>'],
    ['details', '<details open ontoggle="window.__xss=1">x</details>'],
    ['attribut casse', '<div title="a"onmouseover="window.__xss=1">x</div>'],
    ['math', '<math><mtext><table><mglyph><style><img src=x onerror="window.__xss=1">'],
  ])('%s', (_name, payload) => {
    const root = dom(payload)
    expect(root.querySelector('script')).toBeNull()
    expect(hasHandler(root)).toBe(false)
  })

  it.each([
    ['lien', '<a href="javascript:alert(1)">clic</a>'],
    ['lien, casse et espaces', '<a href=" JaVaScRiPt:alert(1)">clic</a>'],
    ['lien, tabulation', '<a href="java\tscript:alert(1)">clic</a>'],
    ['lien, donnees', '<a href="data:text/html,<script>alert(1)</script>">clic</a>'],
  ])('adresse qui execute du code : %s', (_name, payload) => {
    const href = dom(payload).querySelector('a')?.getAttribute('href') ?? ''
    expect(href.replace(/\s/g, '').toLowerCase()).not.toMatch(/^(javascript|data):/)
  })

  it('pas de cadre, de style global, de formulaire ni de champ de saisie', () => {
    const root = dom(`texte
      <iframe src="https://exemple.org"></iframe><object data="x"></object><embed src="x">
      <style>body{display:none}</style><base href="https://exemple.org/"><link rel="stylesheet" href="x"><meta http-equiv="refresh" content="0;url=https://exemple.org">
      <form action="https://exemple.org"><input type="password" name="p"><textarea></textarea><select><option>a</option></select><button>ok</button></form>`)
    for (const tag of ['iframe', 'object', 'embed', 'style', 'base', 'link', 'meta', 'form', 'textarea', 'select', 'button']) {
      expect(root.querySelector(tag), tag).toBeNull()
    }
    expect(root.querySelector('input')).toBeNull()
    expect(root.textContent).toContain('texte')
  })

  it('un lien vers un autre onglet ne garde pas la main sur la page', () => {
    const a = dom('<a href="https://exemple.org" target="_blank">x</a>').querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://exemple.org')
    expect(a.getAttribute('rel')).toContain('noopener')
  })
})

describe('sanitizeHtml : le HTML utile reste', () => {
  it('mise en forme, tableaux, details, images', () => {
    const root = dom(`<p style="color:red">rouge<br>suite</p><mark class="plume-hl">surligne</mark>
      <span class="plume-color plume-color-red" data-x="1">couleur</span>
      <details><summary>Titre</summary>Contenu</details>
      <table><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>
      <img src="https://exemple.org/a.png" alt="image" width="40">
      <a href="#Ma note#Titre">lien interne</a> <a href="https://exemple.org">lien</a>`)
    expect(root.querySelector('p')!.getAttribute('style')).toContain('red')
    expect(root.querySelector('br')).not.toBeNull()
    expect(root.querySelector('mark.plume-hl')).not.toBeNull()
    expect(root.querySelector('span.plume-color')!.getAttribute('data-x')).toBe('1')
    expect(root.querySelector('details summary')!.textContent).toBe('Titre')
    expect(root.querySelectorAll('td, th')).toHaveLength(2)
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://exemple.org/a.png')
    expect(root.querySelector('a')!.getAttribute('href')).toBe('#Ma note#Titre')
  })

  it('les cases a cocher des listes de taches', () => {
    const root = dom(String(marked.parse('- [x] fait\n- [ ] a faire\n')))
    const boxes = root.querySelectorAll('input[type="checkbox"]')
    expect(boxes).toHaveLength(2)
    expect((boxes[0] as HTMLInputElement).hasAttribute('checked')).toBe(true)
  })

  it('le Markdown ordinaire ne change pas', () => {
    const html = String(marked.parse('# Titre\n\nUn **gras**, un `code`, un [lien](https://exemple.org).\n\n> citation\n'))
    const root = dom(html)
    expect(root.querySelector('h1')!.textContent).toBe('Titre')
    expect(root.querySelector('strong')!.textContent).toBe('gras')
    expect(root.querySelector('code')!.textContent).toBe('code')
    expect(root.querySelector('a')!.getAttribute('href')).toBe('https://exemple.org')
    expect(root.querySelector('blockquote')).not.toBeNull()
  })
})

describe('rendu d une note (impression, publication)', () => {
  it('le HTML brut d une note est nettoye', () => {
    const root = renderNoteForPrint('Bonjour\n\n<img src=x onerror="window.__xss=1">\n\n<script>window.__xss=1</script>\n\nFin', { title: 'Piege' })
    expect(root.querySelector('script')).toBeNull()
    expect(hasHandler(root)).toBe(false)
    expect(root.textContent).toContain('Bonjour')
  })
})
