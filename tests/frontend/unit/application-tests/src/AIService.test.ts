// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// L'IA de la personne : connexions, appels au format OpenAI, vue des plugins
// sans cle, fournisseurs ajoutes par des plugins.
import { describe, it, expect } from 'vitest'
import { AIService, AIRequestError, type AIConnection, type AIConnectionStore } from '@savoire/application'
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
