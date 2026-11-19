// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Adaptateurs de protocole d'IA : chacun sait construire la requete d'un
// fournisseur, lire sa reponse, lire son flux et lister ses modeles.
// AIService choisit l'adaptateur par AIProviderSpec.protocol ; le moteur
// d'agents ne voit que AIChatRequest / AIChatResponse.
//
// Un seul pour l'instant : « openai » (POST {adresse}/chat/completions, le
// format de OpenAI, Mistral, OpenRouter, Ollama, LM Studio, vLLM...).
import type { AIChatRequest, AIMessage, AIStreamDelta, AIToolCall } from '@savoire/plugin-api'

/** Ce que l'adaptateur rend ; AIService y ajoute le nom de la connexion. */
export interface AIProtocolResult {
  text: string
  model?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  toolCalls?: AIToolCall[]
}

export interface AIProtocolAdapter {
  readonly id: string
  /** Chemin et corps de la demande (stream : demander un flux). */
  chatRequest(model: string, request: AIChatRequest, stream: boolean): { path: string; body: unknown }
  /** Lit une reponse entiere ; null : forme inattendue. */
  readResponse(data: unknown): AIProtocolResult | null
  /** Lit un flux, morceau par morceau, en appelant onDelta. */
  readStream(res: Response, onDelta: (d: AIStreamDelta) => void): Promise<AIProtocolResult>
  modelsPath: string
  readModels(data: unknown): string[]
}

/** Un message au format OpenAI (appels d'outils compris). */
function toOpenAIMessage(m: AIMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant', content: m.content || null,
      tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
    }
  }
  return { role: m.role, content: m.content }
}

type OpenAIUsage = { prompt_tokens?: number; completion_tokens?: number }
type OpenAIToolCall = { index?: number; id?: string; function?: { name?: string; arguments?: string } }

function usageOf(u: OpenAIUsage | undefined | null): AIProtocolResult['usage'] | undefined {
  return u ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens } : undefined
}

/** Les lignes « data: ... » d'un flux SSE, au fur et a mesure. */
async function* sseData(res: Response): AsyncGenerator<string> {
  if (!res.body) {
    // Sans corps lisible (environnement de test, vieux navigateur) : tout d'un coup.
    for (const line of (await res.text()).split(/\r?\n/)) if (line.startsWith('data:')) yield line.slice(5).trim()
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const lines = buffer.split(/\r?\n/)
    buffer = done ? '' : lines.pop() ?? ''
    for (const line of lines) if (line.startsWith('data:')) yield line.slice(5).trim()
    if (done) return
  }
}

export const openAIProtocol: AIProtocolAdapter = {
  id: 'openai',
  modelsPath: '/models',

  chatRequest(model, request, stream) {
    const body: Record<string, unknown> = { model, messages: request.messages.map(toOpenAIMessage) }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.json) body.response_format = { type: 'json_object' }
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
    }
    if (stream) { body.stream = true; body.stream_options = { include_usage: true } }
    return { path: '/chat/completions', body }
  },

  readResponse(raw) {
    const data = raw as {
      model?: string
      choices?: { message?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[]
      usage?: OpenAIUsage
    } | null
    const message = data?.choices?.[0]?.message
    const toolCalls: AIToolCall[] = (message?.tool_calls ?? [])
      .filter(c => typeof c?.function?.name === 'string')
      .map((c, i) => ({ id: c.id || `call_${i}`, name: c.function!.name!, arguments: c.function!.arguments ?? '{}' }))
    const text = message?.content ?? (toolCalls.length ? '' : undefined)
    if (typeof text !== 'string') return null
    const usage = usageOf(data?.usage)
    return { text, ...(data?.model ? { model: data.model } : {}), ...(usage ? { usage } : {}), ...(toolCalls.length ? { toolCalls } : {}) }
  },

  async readStream(res, onDelta) {
    let text = ''
    let model: string | undefined
    let usage: AIProtocolResult['usage']
    // Les appels d'outils arrivent par morceaux, rattaches par leur index.
    const calls = new Map<number, { id?: string; name: string; arguments: string }>()
    for await (const data of sseData(res)) {
      if (!data || data === '[DONE]') continue
      let chunk: { model?: string; usage?: OpenAIUsage | null; choices?: { delta?: { content?: string | null; tool_calls?: OpenAIToolCall[] } }[] }
      try { chunk = JSON.parse(data) } catch { continue }
      if (chunk.model) model = chunk.model
      if (chunk.usage) usage = usageOf(chunk.usage)
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) { text += delta.content; onDelta({ text: delta.content }) }
      for (const tc of delta?.tool_calls ?? []) {
        const index = tc.index ?? 0
        const cur = calls.get(index) ?? { name: '', arguments: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments) cur.arguments += tc.function.arguments
        calls.set(index, cur)
        onDelta({ toolCall: { index, ...(tc.function?.name ? { name: tc.function.name } : {}), ...(tc.function?.arguments ? { arguments: tc.function.arguments } : {}) } })
      }
    }
    const toolCalls: AIToolCall[] = [...calls.entries()].sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({ id: c.id || `call_${i}`, name: c.name, arguments: c.arguments || '{}' }))
    return { text, ...(model ? { model } : {}), ...(usage ? { usage } : {}), ...(toolCalls.length ? { toolCalls } : {}) }
  },

  readModels(raw) {
    const data = raw as { data?: { id?: string }[] } | null
    return (data?.data ?? []).map(m => m.id).filter((x): x is string => !!x).sort((a, b) => a.localeCompare(b))
  },
}

/** Les protocoles connus, par id. */
export const AI_PROTOCOLS: Readonly<Record<string, AIProtocolAdapter>> = { openai: openAIProtocol }
