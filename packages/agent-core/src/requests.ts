// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Demander a un agent par selection + commentaire.
//
// La personne selectionne un passage et ecrit un commentaire adresse a un
// agent : elle le choisit dans « Demander à… », ou elle ecrit « @Nom ». La
// demande vit sur la racine du fil (Revision), avec son etat :
//  - un agent de l'appli la traite tout de suite : il repond dans ce fil, et
//    ce qu'il ecrit ou propose reste dans ce passage (confineHost) ;
//  - une IA externe (MCP) la lit par list_requests, puis repond dans le fil
//    (reply) : la demande est alors close.
// Une demande n'est jamais traitee deux fois : seules les demandes ouvertes
// sont listees, et celle qu'un agent de l'appli prend ne l'est jamais.
// L'IA de quelqu'un ne prend que SES demandes : celle d'un autre membre du
// vault attend l'IA de ce membre (personne ne fait agir l'IA d'un autre).
//
// Rien ne part tout seul : seule la demande explicite lance un agent.
//
// Ici, la logique pure : qui est vise, les droits d'un agent pour une
// demande, l'hote confine au passage, la consigne, la reponse courte.
import type { AgentDefinition, AgentPermissions, ToolActor } from '@savoire/plugin-api'
import { HostError, type AgentToolHost } from './host'
import { normalizePermissions } from './policy'
import type { TextChange } from './text'

/** Un commentaire d'agent tient en une ou deux phrases. */
export const MAX_AGENT_COMMENT_CHARS = 400
/** Nouveaux fils de commentaire d'un agent sur une note, d'affilee. */
export const MAX_NEW_COMMENTS = 3
/** « D'affilee » : ses fils ouverts, encore sans reponse, des dernieres minutes. */
export const NEW_COMMENTS_WINDOW_MS = 5 * 60_000

/** Ou la demande sera traitee : par un agent de l'appli, ou par une IA externe (MCP). */
export type RequestVia = 'app' | 'external'

/**
 * L'etat d'une demande, sur la racine de son fil :
 *  - open    : a prendre (IA externe) ;
 *  - running : un agent de l'appli y travaille ;
 *  - done    : repondue ;
 *  - failed  : l'agent de l'appli a echoue (la personne peut relancer).
 */
export type RequestState = 'open' | 'running' | 'done' | 'failed'

export interface AskableAgent {
  id: string
  name: string
}

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
const WORD = /[\p{L}\p{N}_-]/u

/**
 * L'agent mentionne dans le texte par « @Nom » (casse et accents ignores). Le
 * nom entier d'abord, le plus long en premier ; sinon son premier mot, s'il ne
 * designe qu'un agent. Null : personne.
 */
export function findAgentMention<T extends AskableAgent>(text: string, agents: readonly T[]): T | null {
  const hay = fold(text)
  const named = agents.filter(a => a.name.trim()).map(a => ({ agent: a, name: fold(a.name.trim()) }))
  const mentions: number[] = []
  for (let i = hay.indexOf('@'); i >= 0; i = hay.indexOf('@', i + 1)) {
    // « jean@exemple.fr » n'est pas une mention.
    if (i === 0 || !WORD.test(hay[i - 1]!)) mentions.push(i + 1)
  }
  const follows = (at: number, name: string): boolean => {
    if (!hay.startsWith(name, at)) return false
    const next = hay[at + name.length]
    return next === undefined || !WORD.test(next)
  }
  for (const at of mentions) {
    const full = [...named].sort((a, b) => b.name.length - a.name.length).find(n => follows(at, n.name))
    if (full) return full.agent
    const first = named.filter(n => follows(at, n.name.split(/\s+/)[0]!))
    if (first.length === 1) return first[0]!.agent
  }
  return null
}

/** Qui la demande vise : l'agent choisi dans « Demander à… », sinon le premier « @Nom ». Null : un simple commentaire. */
export function requestTarget<T extends AskableAgent>(text: string, agents: readonly T[], chosenId?: string | null): T | null {
  if (chosenId) return agents.find(a => a.id === chosenId) ?? null
  return findAgentMention(text, agents)
}

/**
 * Les droits d'un agent pour UNE demande : il lit, et il ecrit dans le
 * passage selon son mode (« demander » devient « proposer » : la proposition
 * s'accepte sur le passage meme). Rien d'autre : ni creer, ni ranger, ni
 * supprimer, ni deleguer, ni commenter (sa reponse est postee dans le fil).
 */
export function requestAgent(agent: AgentDefinition): AgentDefinition {
  const p = normalizePermissions(agent.permissions)
  const permissions: AgentPermissions = {
    read: p.read, edit: p.edit === 'ask' ? 'propose' : p.edit,
    comment: 'deny', create: 'deny', organize: 'deny', delete: 'deny', plugin: 'deny', delegate: 'deny',
  }
  return { ...agent, permissions, delegates: [], canRequestMode: false }
}

export interface RequestScope {
  /** La note du passage. */
  docId: string
  /** Le passage aujourd'hui dans le texte de la note. Null : il n'y est plus. */
  passage(): Promise<{ from: number; to: number } | null>
}

const OUTSIDE = 'Cette demande porte sur un passage précis : vous n’écrivez que dans ce passage.'
const ONLY_PASSAGE = 'Pour cette demande, vous ne faites que lire, et écrire dans le passage visé.'

/**
 * Le meme hote, confine a une demande : on lit partout ou la personne lit,
 * on n'ecrit (ou ne propose) que dans le passage. Le reste est refuse.
 */
export function confineHost(host: AgentToolHost, scope: RequestScope): AgentToolHost {
  // Apres une ecriture de l'agent, on suit le passage nous-memes : ses ancres ont pu partir avec le texte remplace.
  let tracked: { from: number; to: number } | null = null
  const passage = async (): Promise<{ from: number; to: number }> => {
    const p = tracked ?? await scope.passage().catch(() => null)
    if (!p) throw new HostError('Le passage de la demande n’est plus dans la note.', 'not_found')
    return p
  }
  const within = async (docId: string, ranges: readonly { from: number; to: number }[]): Promise<{ from: number; to: number }> => {
    if (docId !== scope.docId) throw new HostError(OUTSIDE, 'denied')
    const p = await passage()
    if (ranges.some(r => r.from < p.from || r.to > p.to)) throw new HostError(OUTSIDE, 'denied')
    return p
  }
  const wrote = (p: { from: number; to: number }, changes: readonly TextChange[]): void => {
    tracked = { from: p.from, to: p.to + changes.reduce((n, c) => n + c.text.length - (c.to - c.from), 0) }
  }
  const denied = async (): Promise<never> => { throw new HostError(ONLY_PASSAGE, 'denied') }
  const applyChanges = host.applyChanges?.bind(host)
  const resolveRelative = host.resolveRelative?.bind(host)
  const typing = host.typing?.bind(host)
  const signal = host.signal?.bind(host)
  return {
    listNotes: p => host.listNotes(p),
    search: p => host.search(p),
    findNote: ref => host.findNote(ref),
    readNote: ref => host.readNote(ref),
    power: (c, m, p) => host.power(c, m, p),
    listReview: docId => host.listReview(docId),
    async replaceText(docId, from, to, text, actor) {
      const p = await within(docId, [{ from, to }])
      await host.replaceText(docId, from, to, text, actor)
      wrote(p, [{ from, to, text }])
    },
    ...(applyChanges ? {
      async applyChanges(docId: string, changes: readonly TextChange[], actor: ToolActor, opts?: { typing?: boolean; expect?: string }) {
        const p = await within(docId, changes)
        await applyChanges(docId, changes, actor, opts)
        wrote(p, changes)
      },
    } : {}),
    async suggest(docId, from, to, replacement, actor, note) {
      await within(docId, [{ from, to }])
      return host.suggest(docId, from, to, replacement, actor, note)
    },
    async recordEdit(docId, text, actor) {
      if (docId !== scope.docId) throw new HostError(OUTSIDE, 'denied')
      await host.recordEdit(docId, text, actor)
    },
    createNote: denied, createFolder: denied, moveNote: denied, trashNote: denied,
    comment: denied, reply: denied,
    ...(resolveRelative ? { resolveRelative } : {}),
    ...(typing ? { typing } : {}),
    ...(signal ? { signal } : {}),
  }
}

/** Coupe une reponse trop longue a la fin d'une phrase (sinon d'un mot), avec « … ». */
export function clipComment(text: string, max = MAX_AGENT_COMMENT_CHARS): string {
  const t = text.trim().replace(/\n{3,}/g, '\n\n')
  if (t.length <= max) return t
  const head = t.slice(0, max - 1)
  const sentence = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '), head.lastIndexOf('.\n'))
  if (sentence >= max * 0.5) return `${head.slice(0, sentence + 1)} …`
  const space = head.lastIndexOf(' ')
  return `${(space >= max * 0.5 ? head.slice(0, space) : head).trimEnd()}…`
}

export interface RequestPromptInput {
  path: string
  docId: string
  /** Le passage selectionne ('' : la note entiere). */
  quote: string
  /** Ce que la personne demande. */
  text: string
  /** Qui demande. */
  author: string
  /** Le fil avant cette demande (une relance) : qui a dit quoi. */
  thread?: readonly { author: string; text: string }[]
  /** L'agent ecrit-il dans le passage, ou propose-t-il ? Absent : il ne fait que lire. */
  writes?: 'direct' | 'propose'
}

/** La consigne d'une execution sur une demande. */
export function requestPrompt(p: RequestPromptInput): string {
  const earlier = p.thread?.length
    ? ['', 'Le fil jusqu’ici :', ...p.thread.map(e => `- ${e.author} : ${e.text}`)]
    : []
  const where = p.quote
    ? `sur ce passage de la note « ${p.path} » (id : ${p.docId}) :\n<<<\n${p.quote}\n>>>`
    : `sur la note « ${p.path} » (id : ${p.docId})`
  const write = p.writes === 'direct'
    ? '- Si elle demande de modifier, modifie ce passage seulement (edit_note ou patch_note) : ailleurs, l’écriture est refusée.'
    : p.writes === 'propose'
      ? '- Si elle demande de modifier, propose la modification de ce passage seulement (edit_note ou patch_note) : elle l’acceptera ou la refusera sur place. Ailleurs, c’est refusé.'
      : '- Tu ne modifies rien : tu réponds seulement.'
  return [
    `${p.author} t’adresse une demande dans un commentaire, ${where}`,
    ...earlier,
    '',
    `Sa demande : ${p.text}`,
    '',
    'Règles :',
    write,
    `- Ta réponse finale est postée telle quelle dans le fil de ce commentaire : une ou deux phrases, ${MAX_AGENT_COMMENT_CHARS} caractères au plus, sans titre ni liste. Si tu as modifié ou proposé quelque chose, dis-le en une phrase.`,
    '- N’ouvre pas d’autre commentaire, et ne t’occupe que de cette demande.',
  ].join('\n')
}

// ── La boite de commentaire (« Demander à… ») ──────────────────────────────

/** Le choix fait dans « Demander à… » : '' (personne), 'app:<id>' ou 'external:<id>'. */
export function askChoice(via: RequestVia, agentId: string): string {
  return `${via}:${agentId}`
}

function parseAskChoice(choice: string | null | undefined): { via: RequestVia; agentId: string } | null {
  const m = /^(app|external):(.+)$/.exec(choice ?? '')
  return m ? { via: m[1] as RequestVia, agentId: m[2]! } : null
}

/**
 * A qui va le commentaire qu'on envoie, et par ou : l'agent choisi dans
 * « Demander à… », sinon le premier « @Nom » du texte. `inApp` : une IA est
 * configuree dans l'appli (l'agent y tourne tout de suite) ; sinon la demande
 * attend une IA externe. Null : un simple commentaire.
 */
export function resolveAsk<T extends AskableAgent>(text: string, agents: readonly T[], choice: string | null | undefined, inApp: boolean): { agent: T; via: RequestVia } | null {
  const picked = parseAskChoice(choice)
  const agent = requestTarget(text, agents, picked?.agentId)
  if (!agent) return null
  return { agent, via: picked?.via === 'external' || !inApp ? 'external' : 'app' }
}

/** L'etat d'une demande, en une ligne pour la carte du fil. `stale` : « en cours » depuis trop longtemps. */
export function requestLine(r: { agentName: string; state: RequestState; error?: string }, stale = false): string {
  const to = `Demande à ${r.agentName}`
  switch (r.state) {
    case 'running': return stale ? `${to} : interrompue.` : `${to} : il y travaille…`
    case 'open': return `${to} : en attente de son IA (ChatGPT, Claude…).`
    case 'done': return `${to} : répondue.`
    case 'failed': return `${to} : échec${r.error ? ` (${r.error})` : ''}.`
  }
}
