// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// La carte d'annotation : un ou plusieurs fils de la revision, poses
// par-dessus le document (Plume, editeurs des plugins). On y lit le fil, on y
// repond, on accepte ou refuse une suggestion, on resout un commentaire, sans
// passer par le panneau Revision.
//
// DOM simple, sans React : la carte vit dans l'editeur (ADR-023), ou dans le
// conteneur qu'un plugin donne. Elle se redessine quand la revision change,
// en gardant ce qu'on tapait dans une reponse.
//
// Demander a un agent : le brouillon d'un commentaire offre « Demander à… »
// (et comprend « @Nom ») ; la carte du fil dit ou en est la demande. La carte
// ne decide rien : qui est vise et quoi lancer viennent de l'appelant
// (agents/agentRequests.ts).
import { describeActor, type ReviewEntry, type ReviewService, type ReviewThread } from '@savoire/application'

/** Une demande a un agent, vue de la carte du fil. */
export interface RequestCardDeps {
  /** Ou en est la demande, en une ligne. */
  line(root: ReviewEntry): string
  /** La demande a echoue ou a ete interrompue : on peut la relancer ici. */
  canRetry(root: ReviewEntry): boolean
  retry(root: ReviewEntry): void
}

/** « Demander à… » dans le brouillon d'un commentaire. */
export interface DraftAskDeps {
  /** Les agents a qui l'on peut demander dans ce vault. */
  agents(): { id: string; name: string }[]
  /** Une IA est configuree dans l'appli : l'agent y repond tout de suite. */
  inApp(): boolean
  /** A qui irait ce texte, avec ce choix ('' , 'app:<id>', 'external:<id>'). Null : un simple commentaire. */
  resolve(text: string, choice: string): DraftAsk | null
}

export interface DraftAsk {
  agent: { id: string; name: string }
  via: 'app' | 'external'
}

/** Ce dont la carte a besoin : la revision, et quoi faire des decisions. */
export interface AnnotationCardDeps {
  review: ReviewService
  /** La personne peut ecrire (repondre, decider). */
  canWrite(): boolean
  /** Description d'une proposition de plugin (son type la decrit). */
  describeProposal(entry: ReviewEntry): string
  accept(root: ReviewEntry): Promise<void>
  reject(root: ReviewEntry): void
  reply(root: ReviewEntry, text: string): void
  resolve(root: ReviewEntry, resolved: boolean): void
  /** Ouvrir le panneau Revision (facultatif). */
  openPanel?(): void
  /** Les demandes aux agents (facultatif : sans lui, la carte ne les montre pas). */
  requests?: RequestCardDeps
}

const KIND_LABEL: Record<string, string> = { comment: 'Commentaire', suggestion: 'Suggestion', proposal: 'Proposition' }
const STATUS_LABEL: Record<string, string> = { accepted: 'Acceptée', rejected: 'Refusée', resolved: 'Résolu' }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(label: string, className: string, testid: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', `annotation-btn ${className}`, label)
  b.type = 'button'
  b.dataset.testid = testid
  // Garder la selection de l'editeur : le clic ne lui vole pas le focus avant l'action.
  b.addEventListener('mousedown', e => e.preventDefault())
  b.addEventListener('click', onClick)
  return b
}

function entryHead(entry: ReviewEntry, label?: string): HTMLElement {
  const head = el('div', 'annotation-head')
  if (entry.author.kind === 'agent') head.append(el('span', 'annotation-ia', 'IA'))
  head.append(el('span', 'annotation-author', describeActor(entry.author)))
  head.append(el('span', 'annotation-date', new Date(entry.createdAt).toLocaleString()))
  if (label) head.append(el('span', 'annotation-kind', label))
  return head
}

/**
 * Dessine la carte des fils `ids` dans `container`. `onDone` : un fil vient
 * d'etre traite (la carte peut se fermer). Rend le nettoyage.
 */
export function renderAnnotationCard(container: HTMLElement, ids: readonly string[], deps: AnnotationCardDeps, onDone?: () => void): () => void {
  const drafts = new Map<string, string>()
  const errors = new Map<string, string>()
  let focused: string | null = null

  const threadsNow = (): ReviewThread[] => ids
    .map(id => deps.review.thread(id))
    .filter((t): t is ReviewThread => !!t)

  const draw = () => {
    const threads = threadsNow()
    container.replaceChildren()
    container.classList.add('annotation-card')
    if (threads.length === 0) {
      container.append(el('div', 'annotation-muted', 'Ce fil n’existe plus.'))
      return
    }
    for (const t of threads) container.append(drawThread(t))
    if (deps.openPanel) {
      const foot = el('div', 'annotation-foot')
      foot.append(button('Voir dans Révision', 'annotation-link', 'annotation-open-panel', () => deps.openPanel!()))
      container.append(foot)
    }
    if (focused) {
      const input = container.querySelector<HTMLInputElement>(`[data-thread="${CSS.escape(focused)}"] input`)
      if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length) }
    }
  }

  const fail = (id: string, err: unknown) => {
    errors.set(id, err instanceof Error ? err.message : String(err))
    draw()
  }

  const drawThread = ({ root, replies }: ReviewThread): HTMLElement => {
    const box = el('div', 'annotation-thread')
    box.dataset.testid = 'annotation-thread'
    box.dataset.thread = root.id
    box.dataset.kind = root.kind
    box.dataset.status = root.status ?? 'open'
    const status = root.status ?? 'open'
    const open = status === 'open'
    const canWrite = deps.canWrite()

    box.append(entryHead(root, KIND_LABEL[root.kind]))
    if (root.kind === 'suggestion' && root.anchor) {
      const diff = el('div', 'annotation-diff')
      if (root.anchor.quote) diff.append(el('span', 'review-delete', clip(root.anchor.quote, 160)))
      if (root.replacement) diff.append(el('span', 'review-insert', clip(root.replacement, 160)))
      else diff.append(el('i', 'annotation-muted', ' (supprimer)'))
      box.append(diff)
    } else if (root.kind === 'proposal') {
      box.append(el('div', 'annotation-diff', deps.describeProposal(root)))
    } else if (root.anchor?.quote) {
      box.append(el('div', 'annotation-quote', clip(root.anchor.quote, 160)))
    }
    const isDefault = (root.kind === 'suggestion' && root.text === 'Suggestion') || (root.kind === 'proposal' && root.text === 'Proposition')
    if (!isDefault && root.text) box.append(el('div', 'annotation-text', root.text))
    // Une demande a un agent : ou elle en est, et la relancer si elle a echoue.
    if (root.request && deps.requests) {
      const line = el('div', 'annotation-request')
      line.dataset.testid = 'annotation-request'
      line.dataset.state = root.request.state
      line.append(el('span', 'annotation-ia', 'IA'), el('span', undefined, deps.requests.line(root)))
      if (canWrite && deps.requests.canRetry(root)) {
        line.append(button('Relancer', '', 'annotation-request-retry', () => {
          errors.delete(root.id)
          try { deps.requests!.retry(root) } catch (err) { fail(root.id, err) }
        }))
      }
      box.append(line)
    }

    for (const r of replies) {
      const reply = el('div', 'annotation-reply')
      reply.dataset.testid = 'annotation-reply'
      reply.append(entryHead(r), el('div', 'annotation-text', r.text))
      box.append(reply)
    }

    if (!open) {
      const by = root.statusBy ? ` par ${describeActor(root.statusBy)}` : ''
      box.append(el('div', 'annotation-status', `${STATUS_LABEL[status] ?? status}${root.partial ? ' en partie' : ''}${by}`))
    }

    if (canWrite) {
      const actions = el('div', 'annotation-actions')
      const decide = (run: () => Promise<void> | void) => () => {
        errors.delete(root.id)
        try {
          const done = run()
          if (done) void done.then(() => onDone?.(), err => fail(root.id, err))
          else onDone?.()
        } catch (err) { fail(root.id, err) }
      }
      if ((root.kind === 'suggestion' || root.kind === 'proposal') && open) {
        actions.append(
          button('Accepter', 'annotation-accept', 'annotation-accept', decide(() => deps.accept(root))),
          button('Refuser', '', 'annotation-reject', decide(() => deps.reject(root))),
        )
      }
      if (root.kind === 'comment') {
        actions.append(open
          ? button('Résoudre', '', 'annotation-resolve', decide(() => deps.resolve(root, true)))
          : button('Rouvrir', '', 'annotation-reopen', () => { try { deps.resolve(root, false) } catch (err) { fail(root.id, err) } }))
      }
      box.append(actions)

      const form = el('div', 'annotation-reply-form')
      const input = el('input', 'annotation-input')
      input.dataset.testid = 'annotation-reply-input'
      input.placeholder = deps.requests && root.kind === 'comment' ? 'Répondre… (@Nom : demander à un agent)' : 'Répondre…'
      input.value = drafts.get(root.id) ?? ''
      const send = () => {
        const text = input.value.trim()
        if (!text) return
        // Vider avant d'envoyer : la revision peut redessiner la carte pendant l'envoi.
        drafts.delete(root.id)
        errors.delete(root.id)
        try {
          deps.reply(root, text)
        } catch (err) { drafts.set(root.id, input.value); fail(root.id, err) }
      }
      input.addEventListener('input', () => { drafts.set(root.id, input.value) })
      input.addEventListener('focus', () => { focused = root.id })
      input.addEventListener('blur', () => { if (focused === root.id) focused = null })
      input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send() } })
      form.append(input, button('Répondre', '', 'annotation-reply-submit', send))
      box.append(form)
    }
    const error = errors.get(root.id)
    if (error) {
      const line = el('div', 'annotation-error', error)
      line.dataset.testid = 'annotation-error'
      box.append(line)
    }
    return box
  }

  draw()
  const stop = deps.review.onChange(draw)
  return () => { stop(); container.replaceChildren() }
}

/**
 * Brouillon dans la carte : commenter le passage, ou suggerer un autre texte.
 * `submit` enregistre (et peut lever une erreur, affichee) ; la carte se
 * ferme ensuite. `ask` : le commentaire peut etre une demande a un agent
 * (« Demander à… », ou « @Nom » dans le texte) ; `submit` recoit alors a qui.
 * Rend le nettoyage.
 */
export function renderDraftCard(
  container: HTMLElement,
  draft: { kind: 'comment' | 'suggestion'; quote: string },
  submit: (text: string, replacement: string, ask: DraftAsk | null) => void,
  close: () => void,
  ask?: DraftAskDeps,
): () => void {
  container.replaceChildren()
  container.classList.add('annotation-card')
  const box = el('div', 'annotation-thread')
  box.dataset.testid = 'annotation-draft'
  box.dataset.kind = draft.kind
  if (draft.quote) box.append(el('div', draft.kind === 'suggestion' ? 'annotation-quote review-delete' : 'annotation-quote', clip(draft.quote, 160)))
  const replacement = el('textarea', 'annotation-input annotation-replacement')
  replacement.dataset.testid = 'annotation-draft-replacement'
  replacement.placeholder = 'Texte proposé (vide : supprimer le passage)'
  replacement.value = draft.quote
  const text = el('textarea', 'annotation-input')
  text.dataset.testid = 'annotation-draft-input'
  text.placeholder = draft.kind === 'suggestion' ? 'Explication (facultative)…' : 'Commenter ce passage…'
  const error = el('div', 'annotation-error')
  error.dataset.testid = 'annotation-error'

  // « Demander à… » : un agent du vault, dans l'appli ou par son IA externe.
  const agents = draft.kind === 'comment' ? ask?.agents() ?? [] : []
  const select = el('select', 'annotation-input annotation-ask')
  select.dataset.testid = 'annotation-draft-ask'
  const hint = el('div', 'annotation-muted')
  hint.dataset.testid = 'annotation-draft-ask-hint'
  if (ask && agents.length) {
    const option = (value: string, label: string): HTMLOptionElement => { const o = el('option', undefined, label); o.value = value; return o }
    const group = (label: string, via: 'app' | 'external'): HTMLOptGroupElement => {
      const g = el('optgroup')
      g.label = label
      for (const a of agents) g.append(option(`${via}:${a.id}`, a.name))
      return g
    }
    select.append(option('', 'Demander à… (personne)'))
    if (ask.inApp()) select.append(group('Dans Savoire, tout de suite', 'app'))
    select.append(group('Par son IA externe (ChatGPT, Claude…)', 'external'))
    text.placeholder = 'Commenter ce passage, ou demander : @Nom…'
  }
  const target = (): DraftAsk | null => (ask && agents.length ? ask.resolve(text.value, select.value) : null)
  const submitButton = button(draft.kind === 'suggestion' ? 'Suggérer' : 'Commenter', 'annotation-accept', 'annotation-draft-submit', () => send())
  /** A qui va le commentaire : dit avant d'envoyer. */
  const showTarget = () => {
    const to = target()
    hint.textContent = !to ? '' : to.via === 'app'
      ? `${to.agent.name} répondra dans ce fil, et n’écrira que dans ce passage.`
      : `${to.agent.name} verra cette demande par son IA externe, et répondra dans ce fil.`
    if (draft.kind === 'comment') submitButton.textContent = to ? 'Demander' : 'Commenter'
  }
  const send = () => {
    error.textContent = ''
    try {
      submit(text.value, replacement.value, target())
      close()
    } catch (err) {
      error.textContent = err instanceof Error ? err.message : String(err)
    }
  }
  const actions = el('div', 'annotation-actions')
  actions.append(submitButton, button('Annuler', '', 'annotation-draft-cancel', close))
  text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() } })
  if (ask && agents.length) {
    text.addEventListener('input', showTarget)
    select.addEventListener('change', showTarget)
  }
  if (draft.kind === 'suggestion') box.append(replacement)
  box.append(text)
  if (ask && agents.length) box.append(select, hint)
  box.append(actions, error)
  container.append(box)
  const first = draft.kind === 'suggestion' ? replacement : text
  requestAnimationFrame(() => { first.focus(); first.setSelectionRange(first.value.length, first.value.length) })
  return () => { container.replaceChildren() }
}
