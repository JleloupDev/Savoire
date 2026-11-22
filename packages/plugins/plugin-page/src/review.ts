// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Revision dans une page : commentaires et suggestions poses sur un passage,
// montres dans la page et traites d'un clic (carte standard de la revision,
// api.review.renderAnnotation), sans ouvrir le panneau Revision.
//
// Un passage est retenu par son texte (`quote`) et sa position (`at`, en
// positions ProseMirror) au moment ou on l'a vise. On le retrouve en cherchant
// ce texte, au plus pres de la position : il suit ainsi les modifications
// faites avant lui, et disparait s'il est modifie lui-meme (le fil reste dans
// le panneau).
//
// Suggestion : une proposition « page.text » (remplacer `before`, vers `at`,
// par `after`). L'accepter modifie la page ouverte.
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { ProposalTypeSpec, ReviewAnnotation, TextCommentTarget } from '@savoire/plugin-api'

export const PAGE_TEXT_PROPOSAL = 'page.text'

/** Suggestion dans une page : remplacer `before` (vers la position `at`) par `after`. */
export interface PageTextProposal {
  at: number
  before: string
  after: string
}

/** Le texte de la page, a plat, et la position ProseMirror de chaque caractere (-1 : saut de bloc). */
export function flatten(doc: PMNode): { text: string; pos: number[] } {
  let text = ''
  const pos: number[] = []
  let first = true
  doc.descendants((node, at) => {
    if (node.isTextblock) {
      if (!first) { text += '\n'; pos.push(-1) }
      first = false
      return true
    }
    if (node.isText) {
      const s = node.text ?? ''
      for (let i = 0; i < s.length; i++) pos.push(at + i)
      text += s
    }
    return true
  })
  return { text, pos }
}

/** Le passage `quote` le plus proche de la position `at` ; null s'il n'est plus dans la page. */
export function locateInDoc(doc: PMNode, quote: string, at: number): { from: number; to: number } | null {
  if (!quote) return null
  const { text, pos } = flatten(doc)
  let best: { from: number; to: number } | null = null
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
    const from = pos[i]
    const last = pos[i + quote.length - 1]
    if (from < 0 || last < 0) continue
    if (!best || Math.abs(from - at) < Math.abs(best.from - at)) best = { from, to: last + 1 }
  }
  return best
}

const isTextTarget = (v: unknown): v is TextCommentTarget =>
  !!v && typeof (v as TextCommentTarget).at === 'number' && typeof (v as TextCommentTarget).quote === 'string'

const asProposal = (payload: unknown): PageTextProposal | null => {
  const p = payload as PageTextProposal | null
  return p && typeof p.at === 'number' && typeof p.before === 'string' && typeof p.after === 'string' ? p : null
}

/** Les passages a montrer : fils ouverts qui visent un texte de la page. */
function decorate(doc: PMNode, annotations: readonly ReviewAnnotation[]): DecorationSet {
  const decos: Decoration[] = []
  for (const a of annotations) {
    if (a.status !== 'open') continue
    if (a.kind === 'comment' && isTextTarget(a.target)) {
      const at = locateInDoc(doc, a.target.quote, a.target.at)
      if (at) decos.push(Decoration.inline(at.from, at.to, { class: 'review-mark review-clickable', 'data-highlight-id': a.id, title: `Commentaire : ${a.text.slice(0, 80)}` }, { id: a.id }))
    } else if (a.kind === 'proposal' && a.proposalType === PAGE_TEXT_PROPOSAL) {
      const p = asProposal(a.payload)
      const at = p && locateInDoc(doc, p.before, p.at)
      if (!p || !at) continue
      const title = `Suggestion de ${a.authorName}`
      decos.push(Decoration.inline(at.from, at.to, { class: 'review-mark review-mark-suggestion review-clickable', 'data-highlight-id': a.id, title }, { id: a.id }))
      if (p.after) {
        const id = a.id
        const after = p.after
        decos.push(Decoration.widget(at.to, () => {
          const span = document.createElement('span')
          span.className = 'review-insert review-clickable'
          span.dataset.highlightId = id
          span.title = title
          span.textContent = after
          return span
        }, { id, side: 1, key: `ins-${id}-${after}` }))
      }
    }
  }
  return DecorationSet.create(doc, decos)
}

interface ReviewPluginState {
  annotations: readonly ReviewAnnotation[]
  decorations: DecorationSet
}

export const pageReviewKey = new PluginKey<ReviewPluginState>('pageReview')

/** Fils ouverts a une position : du passage le plus court au plus long. */
export function annotationIdsAt(state: EditorState, pos: number): string[] {
  const set = pageReviewKey.getState(state)?.decorations
  if (!set) return []
  const found = set.find(pos, pos).map(d => ({ id: (d.spec as { id?: string }).id, size: d.to - d.from }))
  const ids: string[] = []
  for (const f of found.sort((a, b) => a.size - b.size)) if (f.id && !ids.includes(f.id)) ids.push(f.id)
  return ids
}

/**
 * L'extension de la page : passages surlignes, et clic. `onOpen` recoit les
 * fils vises et la position cliquee (pour placer la carte).
 */
export function pageReviewExtension(onOpen: (ids: string[], pos: number) => void): Extension {
  return Extension.create({
    name: 'pageReview',
    addProseMirrorPlugins() {
      return [new Plugin<ReviewPluginState>({
        key: pageReviewKey,
        state: {
          init: (_config, state) => ({ annotations: [], decorations: DecorationSet.create(state.doc, []) }),
          apply(tr, value, _old, state) {
            const next = tr.getMeta(pageReviewKey) as readonly ReviewAnnotation[] | undefined
            if (next) return { annotations: next, decorations: decorate(state.doc, next) }
            if (!tr.docChanged) return value
            return { annotations: value.annotations, decorations: decorate(state.doc, value.annotations) }
          },
        },
        props: {
          // Meme prosemirror-view que l'editeur (@tiptap/pm) ; seuls les types de
          // prosemirror-state en voient une autre copie, d'ou la conversion.
          decorations: state => pageReviewKey.getState(state)?.decorations as never,
          handleClick(view, pos, event) {
            const target = (event.target as HTMLElement | null)?.closest?.('[data-highlight-id]') as HTMLElement | null
            const ids = annotationIdsAt(view.state, pos)
            const first = target?.dataset.highlightId
            if (first && !ids.includes(first)) ids.unshift(first)
            if (ids.length) onOpen(ids, pos)
            return false
          },
        },
      })]
    },
  })
}

/** Donne a l'editeur les fils de la page (vide : rien a montrer). */
export function setPageAnnotations(editor: Editor, annotations: readonly ReviewAnnotation[]): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr.setMeta(pageReviewKey, annotations).setMeta('addToHistory', false))
}

// ── Accepter une suggestion : la page doit etre ouverte ─────────────────

const openEditors = new Map<string, Set<Editor>>()

/** Une page ouverte (son document) : la suggestion s'y applique. Rend le retrait. */
export function trackReviewEditor(docId: string, editor: Editor): () => void {
  let set = openEditors.get(docId)
  if (!set) { set = new Set(); openEditors.set(docId, set) }
  set.add(editor)
  return () => {
    set!.delete(editor)
    if (set!.size === 0) openEditors.delete(docId)
  }
}

/** Applique une suggestion a la page ouverte. */
export function applyPageProposal(editor: Editor, p: PageTextProposal): void {
  const at = locateInDoc(editor.state.doc, p.before, p.at)
  if (!at) throw new Error('Le passage a changé depuis la suggestion.')
  const tr = p.after ? editor.state.tr.insertText(p.after, at.from, at.to) : editor.state.tr.delete(at.from, at.to)
  editor.view.dispatch(tr)
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Le type de proposition des pages (declare par le plugin). */
export const pageProposalType: ProposalTypeSpec = {
  type: PAGE_TEXT_PROPOSAL,
  label: 'Texte de page',
  describe(payload) {
    const p = asProposal(payload)
    if (!p) return 'Proposition illisible.'
    if (!p.after) return `Supprimer « ${clip(p.before, 200)} »`
    return `« ${clip(p.before, 200)} » → « ${clip(p.after, 200)} »`
  },
  async apply(docId, payload) {
    const p = asProposal(payload)
    if (!p) throw new Error('Proposition illisible.')
    const editor = [...(openEditors.get(docId) ?? [])].find(e => !e.isDestroyed && e.isEditable)
    if (!editor) throw new Error('Ouvrez la page pour accepter cette suggestion.')
    applyPageProposal(editor, p)
  },
}
