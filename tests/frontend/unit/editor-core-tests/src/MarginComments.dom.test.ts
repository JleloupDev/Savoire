// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Commentaires dans la marge : une carte par fil, a la hauteur de son
// passage ; les cartes au meme endroit s'empilent, la carte choisie s'aligne
// exactement ; editeur etroit : pas de marge, la carte flottante revient.
//
// La mise en page (hauteurs en entree, hauts en sortie) est testee a part :
// le DOM simule ne mesure rien.
import { describe, it, expect, afterEach } from 'vitest'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { applyHighlights, highlightRangesById, highlightsExtension } from '../../../../../packages/editor-core/src/Highlights'
import {
  annotationsExtension, openAnnotationDraft, openAnnotations, openedAnnotation, setAnnotationHost, type AnnotationHost,
} from '../../../../../packages/editor-core/src/Annotations'
import {
  MARGIN_COLUMN_WIDTH, applyMarginComments, layoutMargin, marginCommentsExtension, marginCommentsState, marginGeometry,
  selectMarginComment, type MarginComment,
} from '../../../../../packages/editor-core/src/MarginComments'

const tops = (boxes: { id: string; top: number; height: number }[], anchor: string | null = null, gap = 8, min = 0) =>
  Object.fromEntries(layoutMargin(boxes, anchor, gap, min))

describe('mise en page de la marge', () => {
  it('sans chevauchement, chaque carte est a la hauteur de son passage', () => {
    expect(tops([{ id: 'a', top: 10, height: 40 }, { id: 'b', top: 200, height: 40 }])).toEqual({ a: 10, b: 200 })
  })

  it('au meme endroit, les cartes s\'empilent vers le bas, dans l\'ordre du texte', () => {
    expect(tops([
      { id: 'a', top: 100, height: 40 },
      { id: 'b', top: 100, height: 60 },
      { id: 'c', top: 120, height: 40 },
      { id: 'd', top: 500, height: 40 },
    ])).toEqual({ a: 100, b: 148, c: 216, d: 500 })
  })

  it('trie par hauteur, quel que soit l\'ordre recu', () => {
    expect(tops([{ id: 'bas', top: 300, height: 40 }, { id: 'haut', top: 20, height: 40 }])).toEqual({ haut: 20, bas: 300 })
  })

  it('la carte choisie est exactement a sa hauteur : celles du dessus remontent, celles du dessous suivent', () => {
    const boxes = [
      { id: 'a', top: 100, height: 40 },
      { id: 'b', top: 100, height: 40 },
      { id: 'c', top: 110, height: 120 },
      { id: 'd', top: 150, height: 40 },
    ]
    // Sans choix : c est poussee a 196.
    expect(tops(boxes)).toEqual({ a: 100, b: 148, c: 196, d: 324 })
    // c choisie : a sa hauteur (110) ; b et a remontent juste assez ; d passe dessous.
    expect(tops(boxes, 'c')).toEqual({ a: 14, b: 62, c: 110, d: 238 })
  })

  it('une carte du dessus qui a deja la place ne bouge pas', () => {
    expect(tops([
      { id: 'loin', top: 0, height: 40 },
      { id: 'a', top: 200, height: 40 },
      { id: 'b', top: 200, height: 40 },
    ], 'b')).toEqual({ loin: 0, a: 152, b: 200 })
  })

  it('pas de place au-dessus (haut de la note) : les cartes se serrent en haut, la carte choisie au plus pres', () => {
    const top = [{ id: 'a', top: 0, height: 40 }, { id: 'b', top: 0, height: 40 }, { id: 'c', top: 10, height: 40 }]
    expect(tops(top, 'c')).toEqual({ a: 0, b: 48, c: 96 })
    // Un peu de place au-dessus : elle sert, c descend moins bas que dans l'empilement simple (146).
    const near = [{ id: 'a', top: 50, height: 40 }, { id: 'b', top: 50, height: 40 }, { id: 'c', top: 60, height: 40 }, { id: 'd', top: 70, height: 40 }]
    expect(tops(near)).toEqual({ a: 50, b: 98, c: 146, d: 194 })
    expect(tops(near, 'c')).toEqual({ a: 0, b: 48, c: 96, d: 144 })
    // Le haut permis peut etre au-dessus de la premiere ligne (marge de l'editeur).
    expect(tops(near, 'c', 8, -28)).toEqual({ a: -28, b: 20, c: 68, d: 116 })
  })

  it('une carte choisie inconnue ne change rien ; aucune carte ne passe au-dessus du haut', () => {
    expect(tops([{ id: 'a', top: -30, height: 40 }, { id: 'b', top: 0, height: 40 }], 'zzz')).toEqual({ a: 0, b: 48 })
  })

  it('la colonne ne decale le texte que s\'il manque de la place a sa droite', () => {
    const column = MARGIN_COLUMN_WIDTH
    // Tres large : le texte reste centre, la colonne se pose contre lui.
    expect(marginGeometry(1600, 40, 680, column)).toEqual({ pad: 0, right: (1600 - 40 - 680) / 2 - column })
    // Entre les deux : juste ce qu'il manque.
    const free = 1100 - 40 - 680
    expect(marginGeometry(1100, 40, 680, column)).toEqual({ pad: 2 * column - free, right: 0 })
    // Juste : toute la colonne est reservee, le texte se resserre.
    expect(marginGeometry(820, 40, 680, column)).toEqual({ pad: column, right: 0 })
    // Texte sans largeur maximale.
    expect(marginGeometry(1600, 0, Infinity, column)).toEqual({ pad: column, right: 0 })
  })
})

// ── Dans l'editeur ─────────────────────────────────────────────────────────

const views: EditorView[] = []
afterEach(() => { for (const v of views.splice(0)) v.destroy() })

/** Laisse passer les mesures de l'editeur (et ce qu'elles declenchent). */
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 25)) }

function recordingHost() {
  const rendered: string[][] = []
  const drafts: { kind: string; from: number; to: number }[] = []
  let cleaned = 0
  const closers: (() => void)[] = []
  const host: AnnotationHost = {
    render(ids, dom, close) { rendered.push(ids); closers.push(close); dom.textContent = `fil ${ids.join(',')}`; return () => { cleaned++ } },
    renderDraft(draft, dom, close) { drafts.push(draft); closers.push(close); dom.textContent = 'brouillon'; return () => { cleaned++ } },
  }
  return { host, rendered, drafts, closers, cleaned: () => cleaned }
}

const DOC = 'un deux trois quatre\ncinq six sept huit\nneuf dix'
const ITEMS: MarginComment[] = [
  { id: 'c2', author: 'Bob', text: 'Plus bas', replies: 0 },
  { id: 'c1', author: 'Alice', text: 'A revoir', replies: 2 },
  { id: 's1', author: 'Relecteur (IA)', text: '« six » → « 6 »', replies: 1, label: 'Suggestion', agent: true },
  { id: 'note', author: 'Alice', text: 'Sur toute la note', replies: 0 },
]
const MARKS = [
  { from: 3, to: 7, className: 'review-mark', id: 'c1' },
  { from: 26, to: 29, className: 'review-mark review-mark-suggestion', id: 's1', insert: '6' },
  { from: 39, to: 43, className: 'review-mark', id: 'c2' },
]

function setup(width = 1200, host: AnnotationHost | null = recordingHost().host) {
  const size = { width }
  const view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc: DOC,
      extensions: [
        highlightsExtension(), annotationsExtension(), marginCommentsExtension({ width: () => size.width }),
        // Le DOM simule previent d'un changement de selection en pleine mise a
        // jour : la selection a la souris de CodeMirror reste hors de ces tests.
        EditorView.domEventHandlers({ mousedown: () => true }),
      ],
    }),
  })
  views.push(view)
  if (host) setAnnotationHost(view, host)
  applyHighlights(view, MARKS)
  applyMarginComments(view, ITEMS)
  /** L'editeur change de largeur (dans l'appli : un ResizeObserver previent). */
  const resize = async (w: number) => { size.width = w; applyMarginComments(view, [...ITEMS]); await settle() }
  return { view, resize }
}

const column = (view: EditorView) => view.scrollDOM.querySelector<HTMLElement>('[data-testid="margin-comments"]')!
const cards = (view: EditorView) => Array.from(column(view).querySelectorAll<HTMLElement>('[data-testid="margin-card"]'))
const cardOf = (view: EditorView, id: string) => cards(view).find(c => c.dataset.marginId === id)!
const floating = (view: EditorView) => view.dom.querySelector('[data-testid="annotation-card"]')
const passage = (view: EditorView, id: string) => view.contentDOM.querySelector<HTMLElement>(`[data-highlight-id="${id}"]`)!
const press = (el: Element) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))

describe('commentaires dans la marge', () => {
  it('retrouve le passage de chaque fil, a jour des modifications', () => {
    const { view } = setup()
    expect(Object.fromEntries(highlightRangesById(view.state))).toEqual({ c1: { from: 3, to: 7 }, s1: { from: 26, to: 29 }, c2: { from: 39, to: 43 } })
    view.dispatch({ changes: { from: 0, insert: 'zero ' } })
    expect(highlightRangesById(view.state).get('c1')).toEqual({ from: 8, to: 12 })
  })

  it('une carte par fil qui a un passage, dans l\'ordre du texte ; rien pour un commentaire sur toute la note', async () => {
    const { view } = setup()
    await settle()
    expect(marginCommentsState(view.state)?.visible).toBe(true)
    expect(column(view).classList.contains('is-shown')).toBe(true)
    expect(cards(view).map(c => c.dataset.marginId)).toEqual(['c1', 's1', 'c2'])
    expect(cardOf(view, 'c1').textContent).toBe('Alice2 réponsesA revoir')
    expect(cardOf(view, 's1').textContent).toBe('IARelecteur (IA)Suggestion1 réponse« six » → « 6 »')
    expect(cardOf(view, 'c2').textContent).toBe('BobPlus bas')
  })

  it('un clic sur la carte l\'ouvre sur le fil dessine par l\'hote, et fait ressortir son passage', async () => {
    const h = recordingHost()
    const { view } = setup(1200, h.host)
    await settle()
    cardOf(view, 'c1').querySelector<HTMLElement>('.cm-margin-summary')!.click()
    expect(marginCommentsState(view.state)?.selected).toBe('c1')
    expect(h.rendered).toEqual([['c1']])
    expect(cardOf(view, 'c1').classList.contains('is-selected')).toBe(true)
    expect(cardOf(view, 'c1').querySelector('.cm-margin-body')?.textContent).toBe('fil c1')
    expect(view.contentDOM.querySelector('.cm-margin-active')?.textContent).toBe('deux')
    // Une autre carte : la premiere se referme.
    cardOf(view, 'c2').querySelector<HTMLElement>('.cm-margin-summary')!.click()
    expect(h.rendered).toEqual([['c1'], ['c2']])
    expect(h.cleaned()).toBe(1)
    expect(cardOf(view, 'c1').classList.contains('is-selected')).toBe(false)
    expect(cardOf(view, 'c1').querySelector<HTMLElement>('.cm-margin-summary')!.hidden).toBe(false)
  })

  it('un clic sur le passage choisit sa carte, sans carte flottante ; un clic ailleurs la referme', async () => {
    const h = recordingHost()
    const { view } = setup(1200, h.host)
    await settle()
    press(passage(view, 'c2'))
    expect(marginCommentsState(view.state)?.selected).toBe('c2')
    expect(openedAnnotation(view.state)).toBeNull()
    expect(floating(view)).toBeNull()
    press(view.contentDOM.querySelector('.cm-line')!)
    expect(marginCommentsState(view.state)?.selected).toBeNull()
    expect(h.cleaned()).toBe(1)
  })

  it('Echap dans la carte la referme ; les touches n\'en sortent pas', async () => {
    const { view } = setup()
    await settle()
    expect(selectMarginComment(view, 'c1')).toBe(true)
    let reached = false
    view.dom.addEventListener('keydown', () => { reached = true })
    cardOf(view, 'c1').dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    expect(reached).toBe(false)
    expect(marginCommentsState(view.state)?.selected).toBe('c1')
    cardOf(view, 'c1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(marginCommentsState(view.state)?.selected).toBeNull()
    // Echap dans le texte aussi.
    selectMarginComment(view, 'c2')
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    expect(marginCommentsState(view.state)?.selected).toBeNull()
  })

  it('l\'hote referme la carte (fil traite) ; un fil qui disparait emporte sa carte', async () => {
    const h = recordingHost()
    const { view } = setup(1200, h.host)
    await settle()
    selectMarginComment(view, 'c1')
    h.closers[0]()
    expect(marginCommentsState(view.state)?.selected).toBeNull()
    selectMarginComment(view, 's1')
    applyMarginComments(view, ITEMS.filter(i => i.id !== 's1'))
    expect(marginCommentsState(view.state)?.selected).toBeNull()
    expect(cards(view).map(c => c.dataset.marginId)).toEqual(['c1', 'c2'])
    expect(h.cleaned()).toBe(2)
  })

  it('la carte suit son passage ; passage efface, carte retiree', async () => {
    const { view } = setup()
    await settle()
    view.dispatch({ changes: { from: 0, to: 21 } })
    expect(cards(view).map(c => c.dataset.marginId)).toEqual(['s1', 'c2'])
  })

  it('un fil choisi par le panneau : seulement si la marge le montre', async () => {
    const { view } = setup()
    expect(selectMarginComment(view, 'c1')).toBe(false)
    await settle()
    expect(selectMarginComment(view, 'note')).toBe(false)
    expect(selectMarginComment(view, 'c1')).toBe(true)
  })

  it('« Commenter » ouvre le brouillon dans la marge, a sa place dans le texte', async () => {
    const h = recordingHost()
    const { view } = setup(1200, h.host)
    await settle()
    selectMarginComment(view, 'c1')
    expect(openAnnotationDraft(view, { kind: 'comment', from: 14, to: 20 })).toBe(true)
    expect(floating(view)).toBeNull()
    expect(h.drafts).toEqual([{ kind: 'comment', from: 14, to: 20 }])
    expect(cards(view).map(c => c.textContent)).toEqual(['Alice2 réponsesA revoir', 'brouillon', expect.stringContaining('Relecteur'), 'BobPlus bas'])
    expect(view.contentDOM.querySelector('.cm-margin-draft')?.textContent).toBe('quatre')
    // Le brouillon suit le texte, sans etre redessine.
    view.dispatch({ changes: { from: 0, insert: 'zero ' } })
    expect(marginCommentsState(view.state)?.draft).toEqual({ kind: 'comment', from: 19, to: 25 })
    expect(h.drafts).toHaveLength(1)
    // Choisir un fil ne ferme pas le brouillon ; l'hote le ferme (envoi, annulation).
    selectMarginComment(view, 'c2')
    expect(marginCommentsState(view.state)?.draft).not.toBeNull()
    h.closers[1]()
    expect(marginCommentsState(view.state)?.draft).toBeNull()
    expect(cards(view)).toHaveLength(3)
  })

  it('sans hote, pas de marge', async () => {
    const { view } = setup(1200, null)
    await settle()
    expect(marginCommentsState(view.state)?.visible).toBe(false)
    expect(cards(view)).toHaveLength(0)
    expect(column(view).classList.contains('is-shown')).toBe(false)
  })
})

describe('editeur etroit', () => {
  it('pas de marge : un clic sur le passage ouvre la carte flottante', async () => {
    const h = recordingHost()
    const { view } = setup(600, h.host)
    await settle()
    expect(marginCommentsState(view.state)?.visible).toBe(false)
    expect(column(view).classList.contains('is-shown')).toBe(false)
    press(passage(view, 'c1'))
    expect(openedAnnotation(view.state)).toEqual({ ids: ['c1'] })
    expect(floating(view)?.textContent).toBe('fil c1')
    expect(marginCommentsState(view.state)?.selected).toBeNull()
  })

  it('au doigt : la suite d\'evenements d\'un appui ouvre la carte', async () => {
    const { view } = setup(600)
    await settle()
    const mark = passage(view, 'c2')
    // Un appui : touchstart, touchend, puis les evenements de souris de compatibilite.
    const touch = (type: string) => Object.assign(new Event(type, { bubbles: true, cancelable: true }), { touches: [], targetTouches: [], changedTouches: [] })
    mark.dispatchEvent(touch('touchstart'))
    mark.dispatchEvent(touch('touchend'))
    press(mark)
    mark.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(openedAnnotation(view.state)).toEqual({ ids: ['c2'] })
  })

  it('« Commenter » ouvre le brouillon flottant', async () => {
    const h = recordingHost()
    const { view } = setup(600, h.host)
    await settle()
    expect(openAnnotationDraft(view, { kind: 'comment', from: 14, to: 20 })).toBe(true)
    expect(floating(view)?.textContent).toBe('brouillon')
    expect(marginCommentsState(view.state)?.draft).toBeNull()
  })

  it('l\'editeur s\'elargit : la carte flottante ouverte passe dans la marge', async () => {
    const { view, resize } = setup(600)
    await settle()
    openAnnotations(view, ['c1'], 3)
    expect(floating(view)).not.toBeNull()
    await resize(1200)
    expect(marginCommentsState(view.state)).toMatchObject({ visible: true, selected: 'c1' })
    expect(floating(view)).toBeNull()
  })

  it('l\'editeur retrecit puis s\'elargit : la carte ouverte garde son etat', async () => {
    const h = recordingHost()
    const { view, resize } = setup(1200, h.host)
    await settle()
    selectMarginComment(view, 'c1')
    // Ce qu'on tapait dans la carte.
    cardOf(view, 'c1').querySelector('.cm-margin-body')!.append(' (réponse en cours)')
    await resize(600)
    expect(marginCommentsState(view.state)?.visible).toBe(false)
    expect(column(view).classList.contains('is-shown')).toBe(false)
    expect(view.contentDOM.querySelector('.cm-margin-active')).toBeNull()
    await resize(1200)
    expect(marginCommentsState(view.state)).toMatchObject({ visible: true, selected: 'c1' })
    expect(column(view).classList.contains('is-shown')).toBe(true)
    expect(h.rendered).toEqual([['c1']])
    expect(cardOf(view, 'c1').querySelector('.cm-margin-body')?.textContent).toBe('fil c1 (réponse en cours)')
  })
})

describe('placement des cartes', () => {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  afterEach(() => { if (height) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height) })

  it('les cartes sont posees a la hauteur de leur passage ; la carte choisie s\'aligne', async () => {
    // Le DOM simule ne mesure rien : chaque carte fait 40 px, chaque passage est a 5 px par caractere.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 40 })
    const { view } = setup()
    view.coordsAtPos = pos => ({ top: pos * 5, bottom: pos * 5 + 20, left: 0, right: 0 })
    await settle()
    applyMarginComments(view, [...ITEMS])
    await settle()
    const top = (id: string) => cardOf(view, id).style.top
    // c1 a 15, s1 a 130, c2 a 195 : personne ne se gene, tout est a sa hauteur.
    expect([top('c1'), top('s1'), top('c2')]).toEqual(['15px', '130px', '195px'])
    expect(cardOf(view, 'c1').style.visibility).toBe('')
    // Deux fils sur le meme passage : le second passe dessous ; choisi, il s'aligne et le premier remonte.
    applyHighlights(view, [...MARKS, { from: 26, to: 29, className: 'review-mark', id: 'c3' }])
    applyMarginComments(view, [...ITEMS, { id: 'c3', author: 'Chloé', text: 'Aussi', replies: 0 }])
    await settle()
    expect([top('s1'), top('c3'), top('c2')]).toEqual(['130px', '178px', '226px'])
    selectMarginComment(view, 'c3')
    await settle()
    expect([top('c1'), top('s1'), top('c3'), top('c2')]).toEqual(['15px', '82px', '130px', '195px'])
  })
})
