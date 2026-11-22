// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'IA de la personne : connexions, appels au format OpenAI, vue des plugins
// sans cle, fournisseurs ajoutes par des plugins.
import { describe, it, expect } from 'vitest'
import { AIService, AIRequestError, openAIProtocol, type AIConnection, type AIConnectionStore } from '@savoire/application'
import { AINotConfiguredError } from '@savoire/plugin-api'

function memoryStore(): AIConnectionStore & { list: AIConnection[] } {
  const s = { list: [] as AIConnection[], load: () => s.list.map(c => ({ ...c })), save: (l: AIConnection[]) => { s.list = l.map(c => ({ ...c })) } }
  return s
}

function fakeFetch(reply: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = async (url: string, init: RequestInit = {}) => { calls.push({ url, init }); return reply(url, init) }
  return { fn, calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('IA de la personne', () => {
  it('appelle /chat/completions avec la cle et le modele de la connexion', async () => {
    const f = fakeFetch(() => json({ model: 'm1', choices: [{ message: { content: 'Bonjour' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }))
    const ai = new AIService(memoryStore(), f.fn)
    ai.saveConnection({ name: 'Ma clé', providerId: 'openai', baseUrl: 'https://api.example/v1/', apiKey: 'sk-secret', model: 'm1' })
    const r = await ai.chat({ messages: [{ role: 'user', content: 'Salut' }], temperature: 0, json: true })
    expect(r).toEqual({ text: 'Bonjour', model: 'm1', connection: 'Ma clé', usage: { inputTokens: 3, outputTokens: 1 } })
    expect(f.calls[0].url).toBe('https://api.example/v1/chat/completions')
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe('Bearer sk-secret')
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ model: 'm1', messages: [{ role: 'user', content: 'Salut' }], temperature: 0, response_format: { type: 'json_object' } })
  })

  it('la vue des plugins ne contient aucune cle', async () => {
    const ai = new AIService(memoryStore(), fakeFetch(() => json({ choices: [{ message: { content: 'x' } }] })).fn)
    const api = ai.pluginAPI()
    expect(api.available()).toBe(false)
    await expect(api.chat({ messages: [] })).rejects.toBeInstanceOf(AINotConfiguredError)
    ai.saveConnection({ name: 'A', providerId: 'openai', baseUrl: 'https://a/v1', apiKey: 'sk-tres-secret', model: 'm' })
    expect(api.available()).toBe(true)
    expect(JSON.stringify(api.connections())).not.toContain('sk-tres-secret')
    expect(JSON.stringify(api)).not.toContain('sk-tres-secret')
  })

  it('connexion par defaut, retrait, et erreurs lisibles', async () => {
    const f = fakeFetch(url => (url.includes('/b/') ? json({ error: 'bad key' }, 401) : json({ choices: [{ message: { content: 'A' } }] })))
    const ai = new AIService(memoryStore(), f.fn)
    const a = ai.saveConnection({ name: 'A', providerId: 'openai', baseUrl: 'https://a/v1', apiKey: 'k', model: 'm' })
    const b = ai.saveConnection({ name: 'B', providerId: 'openai', baseUrl: 'https://b/v1', apiKey: 'k', model: 'm' })
    expect(ai.defaultConnection()?.id).toBe(a.id)
    ai.setDefault(b.id)
    await expect(ai.chat({ messages: [] })).rejects.toThrow(/« B » : clé refusée/)
    ai.removeConnection(b.id)
    expect(ai.defaultConnection()?.id).toBe(a.id)
    expect((await ai.chat({ messages: [] })).text).toBe('A')
    expect(() => ai.saveConnection({ name: 'X', providerId: 'openai', baseUrl: 'ftp://x', apiKey: '', model: '' })).toThrow(/Adresse invalide/)
    const down = new AIService(memoryStore(), async () => { throw new TypeError('Failed to fetch') })
    down.saveConnection({ name: 'Local', providerId: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama' })
    await expect(down.chat({ messages: [] })).rejects.toBeInstanceOf(AIRequestError)
  })

  it('un plugin ajoute un fournisseur, et le retire', async () => {
    const ai = new AIService(memoryStore(), fakeFetch(() => json({ data: [{ id: 'b' }, { id: 'a' }] })).fn)
    const off = ai.pluginAPI().registerProvider({ id: 'mistral', name: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', requiresKey: true })
    expect(ai.provider('mistral')?.name).toBe('Mistral')
    expect(await ai.listModels({ name: 'M', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'k' })).toEqual(['a', 'b'])
    off()
    expect(ai.provider('mistral')).toBeUndefined()
    expect(() => ai.registerProvider({ id: 'x', name: 'X', protocol: 'grpc' as never, baseUrl: '', requiresKey: false })).toThrow()
  })
})

/** Un flux SSE au format OpenAI, morceau par morceau (coupe au milieu des lignes). */
function sse(events: unknown[], cut = 7): Response {
  const raw = events.map(e => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('')
  const bytes = new TextEncoder().encode(raw)
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      for (let i = 0; i < bytes.length; i += cut) ctl.enqueue(bytes.slice(i, i + cut))
      ctl.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('Dictée', () => {
  it('envoie le son a /audio/transcriptions, en formulaire, avec la cle', async () => {
    const f = fakeFetch(() => json({ text: ' Bonjour à tous. ' }))
    const ai = new AIService(memoryStore(), f.fn)
    const c = ai.saveConnection({ name: 'Local', providerId: 'openai-compatible', baseUrl: 'http://localhost:8000/v1', apiKey: 'k', model: 'chat' })
    const text = await ai.transcribe(new Blob(['son'], { type: 'audio/webm' }), { connectionId: c.id, model: 'whisper-1', language: 'fr' })
    expect(text).toBe('Bonjour à tous.')
    expect(f.calls[0].url).toBe('http://localhost:8000/v1/audio/transcriptions')
    const headers = f.calls[0].init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer k')
    expect(headers['content-type']).toBeUndefined()
    const form = f.calls[0].init.body as FormData
    expect([form.get('model'), form.get('language')]).toEqual(['whisper-1', 'fr'])
    expect(form.get('file')).toBeInstanceOf(Blob)
    await expect(ai.transcribe(new Blob(['x']), { connectionId: c.id, model: ' ' })).rejects.toBeInstanceOf(AIRequestError)
  })
})

describe('IA en flux', () => {
  const setup = (reply: (url: string, init: RequestInit) => Response) => {
    const f = fakeFetch(reply)
    const ai = new AIService(memoryStore(), f.fn)
    ai.saveConnection({ name: 'A', providerId: 'openai', baseUrl: 'https://a/v1', apiKey: 'k', model: 'm' })
    return { ai, f }
  }

  it('demande un flux, rend le texte morceau par morceau, puis la reponse entiere', async () => {
    const { ai, f } = setup(() => sse([
      { model: 'm-2', choices: [{ delta: { role: 'assistant', content: 'Bon' } }] },
      { choices: [{ delta: { content: 'jour' } }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 2 } },
      '[DONE]',
    ]))
    const deltas: string[] = []
    const r = await ai.chat({ messages: [{ role: 'user', content: 'Salut' }], onDelta: d => { if (d.text) deltas.push(d.text) } })
    expect(deltas).toEqual(['Bon', 'jour'])
    expect(r).toEqual({ text: 'Bonjour', model: 'm-2', connection: 'A', usage: { inputTokens: 4, outputTokens: 2 } })
    expect(JSON.parse(String(f.calls[0]!.init.body))).toMatchObject({ stream: true, stream_options: { include_usage: true } })
  })

  it('les appels d outils arrivent par morceaux et sont recolles', async () => {
    const { ai } = setup(() => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'search', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: 'c2', function: { name: 'read_note', arguments: '{"path":"a.md"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
      '[DONE]',
    ], 5))
    const parts: string[] = []
    const r = await ai.chat({ messages: [], tools: [{ name: 'search', description: '', parameters: {} }], onDelta: d => { if (d.toolCall?.arguments) parts.push(d.toolCall.arguments) } })
    expect(r.toolCalls).toEqual([
      { id: 'c1', name: 'search', arguments: '{"query":"x"}' },
      { id: 'c2', name: 'read_note', arguments: '{"path":"a.md"}' },
    ])
    expect(r.text).toBe('')
    expect(parts.join('')).toContain('"query"')
  })

  it('flux refuse : redemande sans flux', async () => {
    const { ai, f } = setup((_u, init) => (JSON.parse(String(init.body)).stream
      ? json({ error: 'stream not supported' }, 400)
      : json({ choices: [{ message: { content: 'Entier' } }] })))
    const deltas: string[] = []
    const r = await ai.chat({ messages: [], onDelta: d => { if (d.text) deltas.push(d.text) } })
    expect(r.text).toBe('Entier')
    expect(deltas).toEqual(['Entier'])
    expect(f.calls.length).toBe(2)
    expect(JSON.parse(String(f.calls[1]!.init.body)).stream).toBeUndefined()
  })

  it('un service qui repond en JSON malgre la demande est lu tel quel', async () => {
    const { ai, f } = setup(() => json({ choices: [{ message: { content: 'Direct' } }] }))
    const r = await ai.chat({ messages: [], onDelta: () => {} })
    expect(r.text).toBe('Direct')
    expect(f.calls.length).toBe(1)
  })

  it('une cle refusee n est pas redemandee sans flux', async () => {
    const { ai, f } = setup(() => json({ error: 'bad' }, 401))
    await expect(ai.chat({ messages: [], onDelta: () => {} })).rejects.toThrow(/clé refusée/)
    expect(f.calls.length).toBe(1)
  })

  it('sans onDelta, pas de flux demande', async () => {
    const { ai, f } = setup(() => json({ choices: [{ message: { content: 'x' } }] }))
    await ai.chat({ messages: [] })
    expect(JSON.parse(String(f.calls[0]!.init.body)).stream).toBeUndefined()
  })
})

describe('adaptateur de protocole', () => {
  it('le fournisseur porte son protocole : requete, reponse et modeles passent par l adaptateur', async () => {
    const f = fakeFetch(url => (url.endsWith('/models') ? json({ data: [{ id: 'b' }, { id: 'a' }] }) : json({ choices: [{ message: { content: 'ok' } }] })))
    const ai = new AIService(memoryStore(), f.fn)
    ai.registerProvider({ id: 'mistral', name: 'Mistral', protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1', requiresKey: true })
    ai.saveConnection({ name: 'M', providerId: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'k', model: 'small' })
    expect(await ai.listModels({ name: 'M', providerId: 'mistral', baseUrl: 'https://api.mistral.ai/v1', apiKey: 'k' })).toEqual(['a', 'b'])
    expect((await ai.chat({ messages: [] })).text).toBe('ok')
    expect(f.calls[1]!.url).toBe('https://api.mistral.ai/v1/chat/completions')
  })

  it('openai : construit la requete et lit la reponse', () => {
    const { path, body } = openAIProtocol.chatRequest('m', {
      messages: [{ role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 't', arguments: '{}' }] }, { role: 'tool', toolCallId: 'c', content: 'r' }],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }], maxTokens: 9,
    }, false)
    expect(path).toBe('/chat/completions')
    expect(body).toEqual({
      model: 'm', max_tokens: 9,
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 't', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c', content: 'r' },
      ],
      tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }],
    })
    expect(openAIProtocol.readResponse({ nope: 1 })).toBeNull()
    expect(openAIProtocol.readResponse({ choices: [{ message: { content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }))
      .toEqual({ text: 'x', usage: { inputTokens: 1, outputTokens: 2 } })
  })
})

describe('parametres refuses par un modele', () => {
  it('max_tokens puis temperature refuses : la demande est corrigee, et le reste pour ce modele', async () => {
    const f = fakeFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      if ('max_tokens' in body) return json({ error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.", param: 'max_tokens' } }, 400)
      if ('temperature' in body) return json({ error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.", param: 'temperature' } }, 400)
      return json({ choices: [{ message: { content: 'ok' } }] })
    })
    const ai = new AIService(memoryStore(), f.fn)
    ai.saveConnection({ name: 'OpenAI', providerId: 'openai', baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'gpt-5' })
    const r = await ai.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 700, temperature: 0.2 })
    expect(r.text).toBe('ok')
    expect(f.calls).toHaveLength(3)
    const last = JSON.parse(String(f.calls[2].init.body))
    expect(last.max_completion_tokens).toBe(700)
    expect(last).not.toHaveProperty('max_tokens')
    expect(last).not.toHaveProperty('temperature')
    // Appel suivant : directement corrige.
    await ai.chat({ messages: [{ role: 'user', content: 'y' }], maxTokens: 50, temperature: 0.2 })
    expect(f.calls).toHaveLength(4)
  })

  it('une autre erreur 400 n est pas reessayee', async () => {
    const f = fakeFetch(() => json({ error: { message: 'Bad messages' } }, 400))
    const ai = new AIService(memoryStore(), f.fn)
    ai.saveConnection({ name: 'OpenAI', providerId: 'openai', baseUrl: 'https://api.example/v1', apiKey: 'k', model: 'm' })
    await expect(ai.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 10 })).rejects.toBeInstanceOf(AIRequestError)
    expect(f.calls).toHaveLength(1)
  })
})

describe('API d OpenAI', () => {
  it('max_completion_tokens d emblee, sans attendre de refus', async () => {
    const f = fakeFetch(() => json({ choices: [{ message: { content: 'ok' } }] }))
    const ai = new AIService(memoryStore(), f.fn)
    ai.saveConnection({ name: 'OpenAI', providerId: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-5-mini' })
    await ai.chat({ messages: [{ role: 'user', content: 'x' }], maxTokens: 700 })
    const body = JSON.parse(String(f.calls[0].init.body))
    expect(body.max_completion_tokens).toBe(700)
    expect(body).not.toHaveProperty('max_tokens')
  })
})
