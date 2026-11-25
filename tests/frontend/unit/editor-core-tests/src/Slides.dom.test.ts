// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Format slides : une note `type: slides` coupee en diapositives par `---`
// (ligne vide avant), notes du presentateur, reglages ; rendu, presentation,
// export PowerPoint.
import { describe, it, expect, afterEach } from 'vitest'
import { insertIntoSlide, isSlidesNote, readZip, slideDeck, slideIndexAt, slideSteps } from '@savoire/plugin-api'
import { renderSlide, setSlideStep } from '../../../../../packages/editor-core/src/Slides'
import { startSlideShow } from '../../../../../packages/editor-core/src/SlideShow'
import { buildPptx, pptxEntries, readSlideBody, xmlText, type PptxDeck } from '../../../../../packages/editor-core/src/SlidesPptx'
import { SLIDE_COLORS, editorSlideColors } from '../../../../../packages/editor-core/src/Slides'

const DECK = `---
type: slides
thème: sombre
pied: Savoire
---
# Titre de la présentation

Sous-titre

---

## Deuxième

- un
- deux

Notes : penser à sourire
et à respirer

---

## Code

\`\`\`js
const a = 1

---

pas un séparateur
\`\`\`

***

Texte
---
`

describe('slideDeck', () => {
  it('reconnait une presentation par sa propriete type', () => {
    expect(isSlidesNote(DECK)).toBe(true)
    expect(isSlidesNote('---\ntype: présentation\n---\n# A')).toBe(true)
    expect(isSlidesNote('---\ntitre: x\n---\n# A')).toBe(false)
    expect(isSlidesNote('# Pas de proprietes\n\n---\n\nB')).toBe(false)
  })

  it('coupe sur --- precede d une ligne vide, pas dans le code ni sous un paragraphe', () => {
    const deck = slideDeck(DECK)
    expect(deck.slides).toHaveLength(3)
    expect(deck.slides.map(s => s.title)).toEqual(['Titre de la présentation', 'Deuxième', 'Code'])
    // `---` du bloc de code et le Setext `Texte\n---` restent dans la 3e diapositive.
    expect(deck.slides[2]!.markdown).toContain('pas un séparateur')
    expect(deck.slides[2]!.markdown).toContain('Texte\n---')
    expect(deck.slides[2]!.markdown).toContain('***')
  })

  it('lit les notes du presentateur et les reglages', () => {
    const deck = slideDeck(DECK)
    expect(deck.slides[1]!.notes).toBe('penser à sourire\net à respirer')
    expect(deck.slides[1]!.markdown).not.toContain('Notes')
    expect(deck.slides[0]!.cover).toBe(true)
    expect(deck.slides[1]!.cover).toBe(false)
    expect(deck.theme).toBe('sombre')
    expect(deck.footer).toBe('Savoire')
    expect(deck.ratio).toBe('16:9')
    expect(deck.numbers).toBe(true)
    expect(slideDeck('---\ntype: slides\nformat: 4:3\nnuméros: non\n---\nA').ratio).toBe('4:3')
    expect(slideDeck('---\ntype: slides\nnuméros: non\n---\nA').numbers).toBe(false)
  })

  it('trouve la diapositive d une position', () => {
    const deck = slideDeck(DECK)
    expect(slideIndexAt(deck, DECK.indexOf('Sous-titre'))).toBe(0)
    expect(slideIndexAt(deck, DECK.indexOf('- deux'))).toBe(1)
    expect(slideIndexAt(deck, DECK.indexOf('Texte'))).toBe(2)
  })

  it('insere un bloc a la fin d une diapositive, avant ses notes', () => {
    const next = insertIntoSlide(DECK, 2, '![[Intro.anim]]')
    const deck = slideDeck(next)
    expect(deck.slides).toHaveLength(3)
    expect(deck.slides[1]!.markdown.endsWith('![[Intro.anim]]')).toBe(true)
    expect(deck.slides[1]!.notes).toBe('penser à sourire\net à respirer')
    const last = slideDeck(insertIntoSlide(DECK, 1, 'Fin')).slides[0]!
    expect(last.markdown.endsWith('Fin')).toBe(true)
    expect(() => insertIntoSlide(DECK, 9, 'x')).toThrow(/introuvable/)
  })
})

describe('renderSlide', () => {
  it('rend une diapositive a sa taille, avec le theme, le pied et le numero', () => {
    const deck = slideDeck(DECK)
    const el = renderSlide(deck, deck.slides[1]!)
    expect(el.style.width).toBe('1280px')
    expect(el.dataset.theme).toBe('sombre')
    expect(el.querySelector('h2')?.textContent).toBe('Deuxième')
    expect(el.querySelectorAll('li')).toHaveLength(2)
    expect(el.querySelector('.plume-slide-foot')?.textContent).toContain('2 / 3')
    expect(el.textContent).not.toContain('sourire')
  })

  it('suit les couleurs de l editeur par defaut : titres, italique, code', () => {
    const root = document.documentElement
    const vars = { '--bg-base': '#fdf6e3', '--text': '#586e75', '--heading-color': '#cb4b16', '--accent': '#2aa198', '--color-info': 'rgb(38, 139, 210)', '--color-code': '#859900' }
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v)
    try {
      const deck = slideDeck('---\ntype: slides\n---\n## Titre\n\n*mot*\n')
      expect(deck.theme).toBe('éditeur')
      expect(slideDeck('---\ntype: slides\nthème: editeur\n---\nx').theme).toBe('éditeur')
      const c = editorSlideColors()
      expect(c).toMatchObject({ bg: '#fdf6e3', text: '#586e75', heading: '#cb4b16', accent: '#2aa198', em: '#268bd2', code: '#859900', strong: '#586e75' })
      const el = renderSlide(deck, deck.slides[0]!)
      expect(el.dataset.theme).toBe('éditeur')
      expect(el.style.getPropertyValue('--slide-heading')).toBe('#cb4b16')
      expect(el.style.getPropertyValue('--slide-em')).toBe('#268bd2')
    } finally {
      for (const k of Object.keys(vars)) root.style.removeProperty(k)
    }
  })
})

const STYLED = `---
type: slides
transition: glissement
décor: formes
apparition: listes
effet: montée
---
# Titre

---

<!-- transition: zoom; fond: #1e3a5f; décor: aucun -->
![[Images/photo.jpg|fond gauche]]
## Points

- un
- deux
  - sous-point
- trois

. . .

Conclusion

\`\`\`
. . .
<!-- transition: cube -->
\`\`\`

---

![fond](https://exemple.org/ciel.jpg)
## Ciel
`

describe('transitions, apparitions, decor', () => {
  it('lit les reglages de la presentation et ceux d une diapositive', () => {
    const deck = slideDeck(STYLED)
    expect(deck).toMatchObject({ transition: 'glissement', decor: 'formes', builds: true, effect: 'montée' })
    const [one, two, three] = deck.slides
    expect(one!.options).toEqual({ transition: null, effect: null, decor: null, builds: null, background: '' })
    expect(two!.options).toMatchObject({ transition: 'zoom', background: '#1e3a5f', decor: 'aucun' })
    expect(two!.image).toEqual({ markdown: '![[Images/photo.jpg]]', side: 'gauche' })
    expect(two!.markdown.startsWith('## Points')).toBe(true)
    // Dans le code, rien n'est lu ni coupe.
    expect(two!.markdown).toContain('<!-- transition: cube -->')
    expect(slideSteps(two!.markdown)).toHaveLength(2)
    expect(three!.image).toEqual({ markdown: '![](https://exemple.org/ciel.jpg)', side: 'plein' })
    expect(slideDeck('---\ntype: slides\n---\n![fondation](x.png)\n').slides[0]!.image).toBeNull()
    expect(slideDeck('---\ntype: slides\n---\n<!-- fond: url(x) -->\nx').slides[0]!.options.background).toBe('')
  })

  it('rend les etapes : les points un par un, puis le passage apres . . .', () => {
    const deck = slideDeck(STYLED)
    const el = renderSlide(deck, deck.slides[1]!)
    expect(el.dataset.steps).toBe('4')
    expect(el.dataset.effect).toBe('montée')
    expect(el.dataset.image).toBe('gauche')
    expect(el.dataset.decor).toBeUndefined()
    expect(el.style.getPropertyValue('--slide-bg')).toBe('#1e3a5f')
    // Sans plugin des images (test), le lien reste en texte ; dans l'appli, l'image.
    expect(el.querySelector('.plume-slide-image')).not.toBeNull()
    const sky = renderSlide(deck, deck.slides[2]!)
    expect(sky.querySelector<HTMLImageElement>('.plume-slide-image img')?.getAttribute('src')).toBe('https://exemple.org/ciel.jpg')
    const steps = Array.from(el.querySelectorAll<HTMLElement>('[data-step]')).map(e => `${e.dataset.step}:${e.tagName}`)
    expect(steps).toEqual(['1:LI', '2:LI', '3:LI', '4:DIV'])
    // Tout reste visible tant qu'on ne presente pas (export, miniatures).
    expect(el.querySelectorAll('.plume-step-hidden')).toHaveLength(0)
    setSlideStep(el, 1)
    expect(el.querySelectorAll('.plume-step-hidden')).toHaveLength(3)
    const cover = renderSlide(deck, deck.slides[0]!)
    expect(cover.dataset.decor).toBe('formes')
    expect(cover.querySelector('.plume-slide-decor')).not.toBeNull()
    expect(cover.dataset.steps).toBeUndefined()
  })

  it('en presentation, un clic montre l etape suivante, puis passe a la diapositive', () => {
    const show = startSlideShow(STYLED, { start: 1 })!
    const root = document.querySelector<HTMLElement>('[data-testid="slide-show"]')!
    const hidden = () => root.querySelectorAll('.plume-show-layer:last-child .plume-step-hidden').length
    expect(show.step).toBe(0)
    expect(hidden()).toBe(4)
    const key = (k: string) => root.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    key('ArrowRight'); key('ArrowRight')
    expect([show.index, show.step, hidden()]).toEqual([1, 2, 2])
    key('ArrowLeft')
    expect(show.step).toBe(1)
    key('ArrowRight'); key('ArrowRight'); key('ArrowRight')
    expect([show.index, show.step]).toEqual([1, 4])
    key('ArrowRight')
    expect([show.index, show.step]).toEqual([2, 0])
    // En arriere : la diapositive precedente, complete.
    key('ArrowLeft')
    expect([show.index, show.step]).toEqual([1, 4])
    expect(root.querySelectorAll('.plume-show-layer')).toHaveLength(1)
    show.close()
  })
})

describe('startSlideShow', () => {
  afterEach(() => { document.body.replaceChildren() })

  it('avance et recule au clavier, puis se ferme', () => {
    let exited = false
    const show = startSlideShow(DECK, { onExit: () => { exited = true } })!
    const root = document.querySelector<HTMLElement>('[data-testid="slide-show"]')!
    expect(root.dataset.slide).toBe('1')
    const key = (k: string) => root.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
    key('ArrowRight')
    expect(show.index).toBe(1)
    key(' ')
    key('ArrowRight')
    expect(show.index).toBe(2)
    key('Home')
    expect(root.dataset.slide).toBe('1')
    key('3'); key('Enter')
    expect(show.index).toBe(2)
    key('Escape')
    expect(exited).toBe(true)
    expect(document.querySelector('[data-testid="slide-show"]')).toBeNull()
  })

  it('montre les notes en vue presentateur', () => {
    const show = startSlideShow(DECK, { start: 1 })!
    document.querySelector<HTMLElement>('[data-testid="slide-show-presenter"]')!.click()
    expect(document.querySelector('[data-testid="slide-show-notes"]')?.textContent).toContain('penser à sourire')
    show.close()
  })
})

describe('export PowerPoint', () => {
  const deck = (): PptxDeck => ({
    title: 'Essai <&>',
    ratio: '16:9',
    colors: SLIDE_COLORS.clair,
    slides: [
      { title: [{ text: 'Bonjour' }], paragraphs: [{ runs: [{ text: 'Sous-titre' }] }], pictures: [], notes: '', cover: true },
      {
        title: [{ text: 'Liste' }],
        paragraphs: [{ runs: [{ text: 'un ', bold: true }, { text: 'deux', italic: true }], bullet: 'bullet' }, { runs: [{ text: 'sous' }], bullet: 'number', level: 1 }],
        pictures: [{ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), ext: 'png', width: 400, height: 200 }],
        notes: 'Dire bonjour',
        cover: false,
      },
    ],
  })

  it('ecrit les transitions, le decor et l image de fond', () => {
    const d = deck()
    d.slides[0]!.transition = 'fondu'
    d.slides[0]!.decor = 'formes'
    d.slides[1]!.transition = 'glissement'
    d.slides[1]!.decor = 'dégradé'
    d.slides[1]!.background = '#1e3a5f'
    d.slides[1]!.image = { picture: { bytes: new Uint8Array([0xff, 0xd8, 0xff]), ext: 'jpeg', width: 1000, height: 1000 }, side: 'gauche' }
    const entries = pptxEntries(d)
    const text = (p: string) => new TextDecoder().decode(entries.find(e => e.path === p)!.bytes)
    expect(text('ppt/slides/slide1.xml')).toContain('<p:transition spd="med"><p:fade/></p:transition></p:sld>')
    expect(text('ppt/slides/slide1.xml')).toContain('prst="ellipse"')
    const two = text('ppt/slides/slide2.xml')
    expect(two).toContain('<p:push dir="l"/>')
    expect(two).toContain('<a:gradFill')
    expect(two).toContain('r:embed="rId4"')
    // Image carree sur une moitie haute : recadree en largeur, pas deformee.
    expect(two).toMatch(/<a:srcRect l="\d+" r="\d+"\/>/)
    expect(text('ppt/slides/_rels/slide2.xml.rels')).toContain('../media/fond2.jpeg')
    expect(text('[Content_Types].xml')).toContain('Extension="jpeg"')
    for (const e of entries.filter(x => /slide\d\.xml$/.test(x.path))) {
      const doc = new DOMParser().parseFromString(text(e.path), 'application/xml')
      expect(doc.getElementsByTagName('parsererror').length, e.path).toBe(0)
    }
  })

  it('ecrit les parties attendues, les diapositives, les notes et les images', async () => {
    const entries = pptxEntries(deck(), new Date('2026-11-24T10:00:00Z'))
    const paths = entries.map(e => e.path)
    expect(paths[0]).toBe('[Content_Types].xml')
    for (const p of ['ppt/presentation.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'ppt/notesSlides/notesSlide2.xml',
      'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/notesMasters/notesMaster1.xml',
      'ppt/media/image2_1.png', 'docProps/core.xml', '_rels/.rels']) expect(paths).toContain(p)
    const text = (p: string) => new TextDecoder().decode(entries.find(e => e.path === p)!.bytes)
    expect(text('ppt/slides/slide2.xml')).toContain('<a:buChar char="•"/>')
    expect(text('ppt/slides/slide2.xml')).toContain('r:embed="rId3"')
    expect(text('ppt/slides/_rels/slide2.xml.rels')).toContain('../media/image2_1.png')
    expect(text('ppt/notesSlides/notesSlide2.xml')).toContain('Dire bonjour')
    expect(text('docProps/core.xml')).toContain('Essai &lt;&amp;&gt;')
    expect(text('[Content_Types].xml')).toContain('Extension="png"')
    // XML bien forme partout.
    for (const e of entries.filter(x => /\.(xml|rels)$/.test(x.path))) {
      const doc = new DOMParser().parseFromString(text(e.path), 'application/xml')
      expect(doc.getElementsByTagName('parsererror').length, e.path).toBe(0)
    }
    // L'archive se relit.
    const zip = await readZip(new Uint8Array(await buildPptx(deck()).arrayBuffer()))
    expect(zip.map(f => f.path)).toContain('ppt/slides/slide2.xml')
  })

  it('retire les caracteres interdits en XML', () => {
    expect(xmlText('a\u0001b<c')).toBe('ab&lt;c')
  })

  it('lit le titre, les listes et le code dans le rendu', () => {
    const body = document.createElement('div')
    body.innerHTML = '<div class="vault-rendered-block"><h2>Titre</h2></div><div class="vault-rendered-block"><ul><li><strong>a</strong> b<ul><li>c</li></ul></li></ul></div><pre><code>x = 1\ny = 2</code></pre><blockquote><p>cite</p></blockquote>'
    const r = readSlideBody(body)
    expect(r.title.map(x => x.text).join('')).toBe('Titre')
    expect(r.paragraphs[0]).toMatchObject({ bullet: 'bullet', level: 0 })
    expect(r.paragraphs[0]!.runs[0]).toMatchObject({ text: 'a', bold: true })
    expect(r.paragraphs[1]).toMatchObject({ bullet: 'bullet', level: 1, runs: [{ text: 'c' }] })
    expect(r.paragraphs.filter(p => p.mono).map(p => p.runs[0]!.text)).toEqual(['x = 1', 'y = 2'])
    expect(r.paragraphs.at(-1)).toMatchObject({ quote: true })
  })
})
