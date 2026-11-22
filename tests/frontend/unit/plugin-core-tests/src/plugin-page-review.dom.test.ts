// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
// plugin-page : la revision dans la page. Commentaires et suggestions se
// voient sur leur passage, s'ouvrent d'un clic dans la carte de la revision,
// et une suggestion acceptee modifie la page ouverte.
import { describe, expect, it } from 'vitest'
import { InMemorySharedTree } from '@savoire/plugin-runtime'
import type { AnnotationDraftSpec, FileContext, ReviewAPI, ReviewAnnotation, VaultAPI } from '@savoire/plugin-api'
import { createPageView, pageEditorOf, locateInDoc, pageProposalType, PAGE_TEXT_PROPOSAL } from '@savoire/plugin-page'
import { pmToInit } from '@savoire/plugin-page/adapter'

const flush = () => new Promise(r => setTimeout(r, 0))

const DOC = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Le chat dort. Le chat mange.' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'Fin du texte' }] },
  ],
}

function fakeReview(initial: ReviewAnnotation[] = []) {
  let annotations = initial
  let inline = true
  const changes = new Set<() => void>()
  const inlines = new Set<(on: boolean) => void>()
  const rendered: string[][] = []
  const drafts: AnnotationDraftSpec[] = []
  const review = {
    get inline() { return inline },
    onInlineChange: (cb: (on: boolean) => void) => { inlines.add(cb); return () => { inlines.delete(cb) } },
    onChange: (cb: () => void) => { changes.add(cb); return () => { changes.delete(cb) } },
    annotations: () => annotations,
    renderAnnotation: (ids: string[], el: HTMLElement) => { rendered.push(ids); el.textContent = `fils ${ids.join(',')}`; return () => {} },
    renderDraft: (el: HTMLElement, draft: AnnotationDraftSpec) => { drafts.push(draft); el.textContent = 'brouillon'; return () => {} },
  } as unknown as ReviewAPI
  return {
    review, rendered, drafts,
    set(next: ReviewAnnotation[]) { annotations = next; for (const cb of changes) cb() },
    setInline(on: boolean) { inline = on; for (const cb of inlines) cb(on) },
  }
}

const comment = (id: string, quote: string, at: number): ReviewAnnotation => ({
  id, docId: 'p1', kind: 'comment', text: 'A revoir', authorName: 'Alice', byAgent: false, createdAt: '', status: 'open', target: { at, quote }, replies: [],
})
const suggestion = (id: string, before: string, after: string, at: number): ReviewAnnotation => ({
  id, docId: 'p1', kind: 'proposal', text: '', authorName: 'Bob', byAgent: false, createdAt: '', status: 'open',
  proposalType: PAGE_TEXT_PROPOSAL, payload: { at, before, after }, replies: [],
})

async function mount(fake: ReturnType<typeof fakeReview>) {
  const tree = new InMemorySharedTree()
  tree.root.set('doc', pmToInit(DOC))
  const container = document.createElement('div')
  document.body.appendChild(container)
  const vault = { resolveDocumentId: () => 'p1' } as unknown as VaultAPI
  const view = createPageView('Projet.page', { vaultId: 'v', path: 'Projet.page', tree } as unknown as FileContext, { vault, review: fake.review })
  view.mount(container)
  await flush()
  const editor = pageEditorOf(container)!
  fake.set(fake.review.annotations('p1'))
  return { container, view, editor }
}

describe('plugin-page — revision dans la page', () => {
  it('retrouve un passage au plus pres de sa position, meme sur plusieurs blocs', async () => {
    const fake = fakeReview()
    const { editor, view } = await mount(fake)
    const doc = editor.state.doc
    // « Le chat » apparait deux fois : la position choisit.
    expect(locateInDoc(doc, 'Le chat', 1)).toEqual({ from: 1, to: 8 })
    expect(locateInDoc(doc, 'Le chat', 16)).toEqual({ from: 15, to: 22 })
    const across = locateInDoc(doc, 'mange.\nFin', 1)!
    expect(doc.textBetween(across.from, across.to, '\n')).toBe('mange.\nFin')
    expect(locateInDoc(doc, 'absent', 1)).toBeNull()
    view.destroy()
  })

  it('montre commentaires et suggestions sur leur passage, et les retire hors annotations', async () => {
    const fake = fakeReview([comment('c1', 'dort', 9), suggestion('s1', 'mange', 'boit', 23)])
    const { container, view } = await mount(fake)
    expect(container.querySelector('.review-mark[data-highlight-id="c1"]')?.textContent).toBe('dort')
    expect(container.querySelector('.review-mark-suggestion[data-highlight-id="s1"]')?.textContent).toBe('mange')
    expect(container.querySelector('.review-insert[data-highlight-id="s1"]')?.textContent).toBe('boit')
    fake.setInline(false)
    expect(container.querySelector('[data-highlight-id]')).toBeNull()
    view.destroy()
  })

  it('un passage suit les modifications faites avant lui', async () => {
    const fake = fakeReview([comment('c1', 'dort', 9)])
    const { container, editor, view } = await mount(fake)
    editor.chain().setTextSelection(1).insertContent('Ici, ').run()
    expect(container.querySelector('.review-mark[data-highlight-id="c1"]')?.textContent).toBe('dort')
    view.destroy()
  })

  it('un clic sur le passage ouvre sa carte', async () => {
    const fake = fakeReview([comment('c1', 'dort', 9)])
    const { container, editor, view } = await mount(fake)
    const mark = container.querySelector<HTMLElement>('[data-highlight-id="c1"]')!
    editor.view.someProp('handleClick', f => f(editor.view, 10, { target: mark } as unknown as MouseEvent))
    expect(fake.rendered).toEqual([['c1']])
    const card = container.querySelector<HTMLElement>('[data-testid="page-annotation"]')!
    expect(card.hidden).toBe(false)
    expect(card.textContent).toBe('fils c1')
    view.destroy()
  })

  it('accepter une suggestion modifie la page ouverte ; un passage change refuse', async () => {
    const fake = fakeReview()
    const { editor, view } = await mount(fake)
    await pageProposalType.apply('p1', { at: 23, before: 'mange', after: 'boit' })
    expect(editor.getText()).toContain('Le chat boit.')
    await expect(pageProposalType.apply('p1', { at: 23, before: 'mange', after: 'dort' })).rejects.toThrow(/changé/)
    view.destroy()
    await expect(pageProposalType.apply('p1', { at: 1, before: 'Le', after: 'Un' })).rejects.toThrow(/Ouvrez la page/)
  })

  it('« Commenter » et « Suggérer » de la barre ouvrent le brouillon sur la selection', async () => {
    const fake = fakeReview()
    const { container, editor, view } = await mount(fake)
    editor.chain().focus().setTextSelection({ from: 9, to: 13 }).run()
    const comment = container.querySelector<HTMLElement>('[data-testid="page-toolbar-button"][data-key="comment"]')!
    comment.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    expect(fake.drafts[0]).toMatchObject({ docId: 'p1', kind: 'comment', quote: 'dort', target: { at: 9, quote: 'dort' } })
    editor.chain().focus().setTextSelection({ from: 9, to: 13 }).run()
    container.querySelector<HTMLElement>('[data-testid="page-toolbar-button"][data-key="suggest"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    const draft = fake.drafts[1]
    expect(draft).toMatchObject({ kind: 'suggestion', proposalType: PAGE_TEXT_PROPOSAL })
    expect(draft.toPayload!('ronfle')).toEqual({ at: 9, before: 'dort', after: 'ronfle' })
    view.destroy()
  })
})
