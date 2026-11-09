// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'IA de la personne (plugin-api/ai.ts) : ses connexions, ses cles, et les
// appels. L'application est la seule a tenir les cles et a faire les appels ;
// les plugins recoivent une vue sans cle (pluginAPI()).
//
// Protocole « openai » : POST {adresse}/chat/completions, le format que
// parlent OpenAI, Mistral, OpenRouter, Ollama, LM Studio, vLLM...
import {
  AINotConfiguredError,
  type AIAPI, type AIChatRequest, type AIChatResponse, type AIConnectionInfo, type AIProviderSpec,
} from '@savoire/plugin-api'

/** Une connexion de la personne, cle comprise. Ne sort jamais de l'application. */
export interface AIConnection {
  id: string
  name: string
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
  isDefault: boolean
}

/** Ou la personne garde ses connexions (navigateur, appli de bureau). */
export interface AIConnectionStore {
  load(): AIConnection[]
  save(connections: AIConnection[]): void
}

export class AIRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
  }
}

/** Fournisseurs livres avec l'application. Les plugins en ajoutent. */
export const BUILTIN_AI_PROVIDERS: AIProviderSpec[] = [
  {
    id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', requiresKey: true,
    keyUrl: 'https://platform.openai.com/api-keys', description: 'ChatGPT et les modèles d’OpenAI.',
  },
  {
    id: 'ollama', name: 'Ollama (sur ce poste)', protocol: 'openai', baseUrl: 'http://localhost:11434/v1', requiresKey: false,
    description: 'Des modèles qui tournent sur votre ordinateur. Rien ne sort du poste.',
  },
  {
    id: 'lmstudio', name: 'LM Studio (sur ce poste)', protocol: 'openai', baseUrl: 'http://localhost:1234/v1', requiresKey: false,
    description: 'Des modèles locaux, servis par LM Studio.',
  },
  {
    id: 'openai-compatible', name: 'Autre service compatible OpenAI', protocol: 'openai', baseUrl: '', requiresKey: true,
    description: 'OpenRouter, vLLM, un service d’entreprise… : son adresse et sa clé.',
  },
]

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export class AIService {
  private readonly providers = new Map<string, AIProviderSpec>()
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly store: AIConnectionStore,
    private readonly fetcher: Fetch = (input, init) => fetch(input, init),
  ) {
    for (const p of BUILTIN_AI_PROVIDERS) this.providers.set(p.id, p)
  }

  // ── Fournisseurs ─────────────────────────────────────────────────────────

  listProviders(): AIProviderSpec[] {
    return [...this.providers.values()]
  }

  provider(id: string): AIProviderSpec | undefined {
    return this.providers.get(id)
  }

  registerProvider(spec: AIProviderSpec): () => void {
    if (!spec.id || !spec.name) throw new Error('fournisseur sans id ou sans nom')
    if (spec.protocol !== 'openai') throw new Error(`protocole inconnu : ${spec.protocol}`)
    if (spec.baseUrl && !/^https?:\/\//.test(spec.baseUrl)) throw new Error('adresse du fournisseur invalide')
    this.providers.set(spec.id, spec)
    this.emit()
    return () => {
      if (this.providers.get(spec.id) === spec) { this.providers.delete(spec.id); this.emit() }
    }
  }

  // ── Connexions de la personne ────────────────────────────────────────────

  connections(): AIConnection[] {
    return this.store.load()
  }

  defaultConnection(): AIConnection | undefined {
    const all = this.connections()
    return all.find(c => c.isDefault) ?? all[0]
  }

  /** Ajoute ou remplace une connexion. La premiere devient celle par defaut. */
  saveConnection(input: Omit<AIConnection, 'id' | 'isDefault'> & { id?: string; isDefault?: boolean }): AIConnection {
    const name = input.name.trim()
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '')
    if (!name) throw new Error('Donnez un nom à la connexion.')
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('Adresse invalide : elle commence par https:// (ou http:// en local).')
    const all = this.connections()
    const id = input.id ?? crypto.randomUUID()
    const isDefault = input.isDefault ?? (all.length === 0 || !!all.find(c => c.id === id)?.isDefault)
    const next: AIConnection = { id, name, providerId: input.providerId, baseUrl, apiKey: input.apiKey.trim(), model: input.model.trim(), isDefault }
    const list = all.filter(c => c.id !== id).map(c => (isDefault ? { ...c, isDefault: false } : c))
    this.store.save([...list, next])
    this.emit()
    return next
  }

  removeConnection(id: string): void {
    let list = this.connections().filter(c => c.id !== id)
    if (list.length && !list.some(c => c.isDefault)) list = list.map((c, i) => ({ ...c, isDefault: i === 0 }))
    this.store.save(list)
    this.emit()
  }

  setDefault(id: string): void {
    this.store.save(this.connections().map(c => ({ ...c, isDefault: c.id === id })))
    this.emit()
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  // ── Appels ───────────────────────────────────────────────────────────────

  async chat(request: AIChatRequest, connectionId?: string): Promise<AIChatResponse> {
    const conn = connectionId ? this.connections().find(c => c.id === connectionId) : this.defaultConnection()
    if (!conn) throw new AINotConfiguredError()
    const model = request.model ?? conn.model
    if (!model) throw new AIRequestError(`Choisissez un modèle pour la connexion « ${conn.name} ».`)
    const body: Record<string, unknown> = { model, messages: request.messages }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.json) body.response_format = { type: 'json_object' }
    const res = await this.call(conn, '/chat/completions', { method: 'POST', body: JSON.stringify(body), signal: request.signal })
    const data = await res.json().catch(() => null) as {
      model?: string
      choices?: { message?: { content?: string | null } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    } | null
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string') throw new AIRequestError(`Réponse inattendue de « ${conn.name} ».`)
    return {
      text, model: data?.model ?? model, connection: conn.name,
      ...(data?.usage ? { usage: { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens } } : {}),
    }
  }

  /** Modeles proposes par le service (pour les reglages). */
  async listModels(conn: Pick<AIConnection, 'name' | 'baseUrl' | 'apiKey'>): Promise<string[]> {
    const res = await this.call(conn, '/models', { method: 'GET' })
    const data = await res.json().catch(() => null) as { data?: { id?: string }[]; models?: { name?: string }[] } | null
    const ids = (data?.data ?? []).map(m => m.id).filter((x): x is string => !!x)
    return ids.sort((a, b) => a.localeCompare(b))
  }

  /** La vue des plugins : reponses et fournisseurs, jamais les cles. */
  pluginAPI(): AIAPI {
    return {
      available: () => this.connections().length > 0,
      connections: (): AIConnectionInfo[] => this.connections().map(({ id, name, providerId, model, isDefault }) => ({ id, name, providerId, model, isDefault })),
      chat: (request, connectionId) => this.chat(request, connectionId),
      registerProvider: spec => this.registerProvider(spec),
    }
  }

  private async call(conn: Pick<AIConnection, 'name' | 'baseUrl' | 'apiKey'>, path: string, init: RequestInit): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (conn.apiKey) headers.authorization = `Bearer ${conn.apiKey}`
    let res: Response
    try {
      res = await this.fetcher(`${conn.baseUrl.replace(/\/+$/, '')}${path}`, { ...init, headers })
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw err
      throw new AIRequestError(`« ${conn.name} » est injoignable. Vérifiez l’adresse ; un service local doit accepter les appels de Savoire (CORS).`)
    }
    if (res.ok) return res
    const detail = await res.text().catch(() => '')
    const reason = res.status === 401 || res.status === 403 ? 'clé refusée'
      : res.status === 404 ? 'adresse ou modèle introuvable'
      : res.status === 429 ? 'trop de demandes ou quota épuisé'
      : `erreur ${res.status}`
    throw new AIRequestError(`« ${conn.name} » : ${reason}.${detail ? ` ${detail.slice(0, 200)}` : ''}`, res.status)
  }

  private emit(): void {
    for (const cb of this.listeners) cb()
  }
}

/** Connexions gardees dans le stockage du navigateur, par compte. */
export function localAIConnectionStore(storage: Pick<Storage, 'getItem' | 'setItem'>, accountId: string): AIConnectionStore {
  const key = `savoire-ai-connections:${accountId}`
  return {
    load: () => {
      try { return JSON.parse(storage.getItem(key) ?? '[]') as AIConnection[] } catch { return [] }
    },
    save: list => storage.setItem(key, JSON.stringify(list)),
  }
}
