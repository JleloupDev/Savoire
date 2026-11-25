// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Demander a un agent par selection + commentaire, dans l'appli
// (agent-core/requests.ts).
//
//  - La personne selectionne un passage, ecrit un commentaire, et l'adresse a
//    un agent : « Demander à… » dans la carte, ou « @Nom » dans le texte.
//  - Une IA est configuree dans l'appli : l'agent tourne tout de suite, ICI
//    (l'appli ou la demande est posee, jamais une autre). Il repond dans le
//    fil, et ce qu'il ecrit ou propose reste dans le passage.
//  - Sinon (ou si elle choisit « par son IA externe ») : la demande attend ;
//    ChatGPT ou Claude la lisent par list_requests et repondent par reply.
//  - Une demande n'est jamais traitee deux fois : prise par l'appli, elle
//    n'est pas « ouverte » ; relancee ou close entre-temps, la reponse d'une
//    execution depassee est jetee.
//  - Rien ne part tout seul : seuls l'envoi du commentaire, une reponse qui
//    mentionne l'agent, ou « Relancer » lancent un agent.
import {
  clipComment, confineHost, effectiveMode, requestAgent, requestLine, requestPrompt, resolveAsk,
} from '@savoire/agent-core'
import {
  ReviewService, describeActor,
  type AgentActor, type IVaultSyncSession, type ReviewAnchor, type ReviewEntry, type ReviewRequestTarget, type UserActor,
} from '@savoire/application'
import type { AgentDefinition } from '@savoire/plugin-api'
import type { DraftAsk, DraftAskDeps, RequestCardDeps } from '../AnnotationCard'
import type { EditorAreaRefs } from '../EditorAreaWidget'
import { aiService } from '../aiService'
import { reviewFor, withReviewText } from '../reviewProposals'
import { agentDirectory, onAgentDirectoryChange } from './agentDirectory'
import { runAgentConfined } from './agentRunner'

let refs: EditorAreaRefs | null = null
let agents: AgentDefinition[] = []
/** Les demandes que CETTE appli traite en ce moment (racines des fils). */
const running = new Set<string>()

// Etat de toute la session (agents, demandes en cours) : un remplacement a
// chaud (Vite) en ferait un second exemplaire, jamais branche.
if (import.meta.hot) import.meta.hot.accept(() => { window.location.reload() })

/** Branche les demandes aux agents (une fois, au demarrage). */
export function startAgentRequests(r: EditorAreaRefs): void {
  if (refs) return
  refs = r
  const load = () => { void agentDirectory()?.list().then(list => { agents = list }, () => { agents = [] }) }
  load()
  onAgentDirectoryChange(load)
}

/** Les agents a qui l'on peut demander dans le vault ouvert. */
export function askableAgents(): AgentDefinition[] {
  const vaultId = refs?.selectedVault.current?.id
  return agents.filter(a => (!a.vaultId || a.vaultId === vaultId) && (!a.scope?.vaultIds?.length || (!!vaultId && a.scope.vaultIds.includes(vaultId))))
}

/** Une IA est configuree dans l'appli : un agent peut y repondre tout de suite. */
export function canAskInApp(): boolean {
  return aiService.connections().length > 0
}

/** « Demander à… » pour le brouillon d'un commentaire. */
export const draftAskDeps: DraftAskDeps = {
  agents: () => askableAgents().map(a => ({ id: a.id, name: a.name })),
  inApp: canAskInApp,
  resolve: (text, choice) => resolveAsk(text, askableAgents(), choice, canAskInApp()),
}

const targetOf = (ask: DraftAsk): ReviewRequestTarget => ({ agentId: ask.agent.id, agentName: ask.agent.name, via: ask.via })

/**
 * Envoie un commentaire ; adresse a un agent (`ask`), c'est une demande :
 * l'agent de l'appli part tout de suite, l'IA externe la trouvera.
 */
export function commentOrAsk(session: IVaultSyncSession, docId: string, text: string, me: UserActor, anchor: ReviewAnchor | undefined, ask: DraftAsk | null): ReviewEntry {
  const review = reviewFor(session)
  const entry = review.comment(docId, text, me, anchor, undefined, ask ? targetOf(ask) : undefined)
  if (ask?.via === 'app') void runRequest(session, entry.id)
  return entry
}

/**
 * Repond dans un fil. Une reponse qui mentionne un agent (« @Nom ») dans un
 * fil de commentaire lui adresse une demande : celle du fil repart.
 */
export function replyOrAsk(session: IVaultSyncSession, root: ReviewEntry, text: string, me: UserActor): void {
  const review = reviewFor(session)
  const ask = root.kind === 'comment' ? resolveAsk(text, askableAgents(), '', canAskInApp()) : null
  // Un agent de l'appli y travaille deja : la reponse part, sans seconde demande.
  const busy = root.request?.state === 'running' && !review.stale(root.request)
  const reply = review.reply(root.id, text, me)
  if (!ask || busy) return
  review.ask(root.id, targetOf(ask), reply.id)
  if (ask.via === 'app') void runRequest(session, root.id)
}

/** Relance une demande echouee ou interrompue, par un agent de l'appli si c'est possible. */
export function retryRequest(session: IVaultSyncSession, root: ReviewEntry): void {
  const r = root.request
  if (!r) return
  const via = r.via === 'app' && canAskInApp() ? 'app' : 'external'
  reviewFor(session).ask(root.id, { agentId: r.agentId, agentName: r.agentName, via })
  if (via === 'app') void runRequest(session, root.id)
}

/** Les demandes, vues de la carte d'un fil. */
export function requestCardDeps(session: IVaultSyncSession): RequestCardDeps {
  const review = reviewFor(session)
  const interrupted = (root: ReviewEntry): boolean => !!root.request && review.stale(root.request) && !running.has(root.id)
  return {
    line: root => (root.request ? requestLine(root.request, interrupted(root)) : ''),
    canRetry: root => root.request?.state === 'failed' || interrupted(root),
    retry: root => retryRequest(session, root),
  }
}

/** Le passage d'une demande aujourd'hui (la note entiere, sans passage). */
function passageOf(session: IVaultSyncSession, root: ReviewEntry): { from: number; to: number } | null {
  return withReviewText(session, root.docId, text => {
    if (!root.anchor) return { from: 0, to: text.length }
    const at = ReviewService.locate(root.anchor, text)
    return at ? { from: at.from, to: at.to } : null
  })
}

/**
 * L'agent traite la demande du fil `rootId`, prise par cette appli (etat
 * « running »). Il repond dans le fil ; en cas d'echec, la demande le dit.
 */
export async function runRequest(session: IVaultSyncSession, rootId: string): Promise<void> {
  const review = reviewFor(session)
  const thread = review.thread(rootId)
  const request = thread?.root.request
  if (!thread || !request || request.via !== 'app' || request.state !== 'running' || running.has(rootId)) return
  running.add(rootId)
  const { askedAt } = request
  try {
    const r = refs
    const client = r?.vaultAPI.current
    const account = r?.activeAccount.current
    const vault = r?.selectedVault.current
    if (!r || !client || !account || !vault || r.vaultSession.current !== session) throw new Error('Vault indisponible.')
    const agent = agents.find(a => a.id === request.agentId) ?? (await agentDirectory()?.list().catch(() => []))?.find(a => a.id === request.agentId)
    if (!agent) throw new Error(`l’agent « ${request.agentName} » n’existe plus`)
    const displayName = account.displayName || account.userId
    const person = { userId: account.userId, displayName, canWrite: !r.isReadOnly.current && vault.role !== 'viewer' }
    // Sa reponse est un commentaire : il lui faut ce droit.
    if (effectiveMode(agent, 'comment', person) === 'deny') throw new Error(`« ${agent.name} » n’a pas le droit de commenter : il ne peut pas répondre ici`)
    const { root, replies } = thread
    const ask = replies.find(e => e.id === request.entryId) ?? root
    const earlier = ask === root ? [] : [root, ...replies.slice(0, replies.indexOf(ask))]
    const narrowed = requestAgent(agent)
    const mode = effectiveMode(narrowed, 'edit', person)
    const run = await runAgentConfined({
      agent: narrowed,
      input: requestPrompt({
        path: client.documents.find(d => d.id === root.docId)?.path ?? root.docId, docId: root.docId,
        quote: root.anchor?.quote ?? '', text: ask.text, author: describeActor(ask.author),
        thread: earlier.map(e => ({ author: describeActor(e.author), text: e.text })),
        ...(mode === 'direct' || mode === 'propose' ? { writes: mode } : {}),
      }),
      person, vaultId: vault.id, client, session, api: r.pluginAPI.current as never,
      confine: host => confineHost(host, { docId: root.docId, passage: async () => passageOf(session, root) }),
    })
    if (run.status !== 'done' || !run.answer?.trim()) throw new Error(run.error ?? 'l’agent n’a pas répondu')
    // Relancee ou close entre-temps : cette reponse ne compte plus.
    if (!review.isRunning(rootId, askedAt)) return
    const author: AgentActor = { kind: 'agent', agentId: agent.id, agentName: agent.name, onBehalfOf: { userId: account.userId, displayName } }
    review.reply(rootId, clipComment(run.answer), author)
    review.finishRequest(rootId, askedAt, 'done')
  } catch (err) {
    try { review.finishRequest(rootId, askedAt, 'failed', err instanceof Error ? err.message : String(err)) } catch { /* fil supprime entre-temps */ }
  } finally {
    running.delete(rootId)
  }
}
