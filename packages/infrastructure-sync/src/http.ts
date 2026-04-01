// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
export interface HttpClientOptions {
  baseUrl?: string
  getToken?: () => string | null | undefined
  fetchFn?: typeof fetch
}

export class HttpClient {
  private readonly baseUrl: string
  private readonly getToken: () => string | null | undefined
  private readonly fetchFn: typeof fetch

  constructor(options: HttpClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    this.getToken = options.getToken ?? (() => null)
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  }

  async getJson<T>(path: string): Promise<T> {
    return this.requestJson<T>(path, { method: 'GET' })
  }

  async postJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(path, { method: 'POST', body: JSON.stringify(body) })
  }

  async patchJson<T>(path: string, body: unknown): Promise<T> {
    return this.requestJson<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
  }

  async putText(path: string, body: string): Promise<void> {
    const headers = this.makeHeaders({ 'Content-Type': 'text/markdown' })
    const res = await this.fetchFn(this.resolve(path), { method: 'PUT', headers, body })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  }

  async getText(path: string): Promise<string> {
    const res = await this.fetchFn(this.resolve(path), { method: 'GET', headers: this.makeHeaders() })
    if (res.status === 404) return ''
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.text()
  }

  async delete(path: string): Promise<void> {
    const res = await this.fetchFn(this.resolve(path), { method: 'DELETE', headers: this.makeHeaders() })
    if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`)
  }

  private async requestJson<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.fetchFn(this.resolve(path), {
      ...init,
      headers: this.makeHeaders({ 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return res.json() as Promise<T>
  }

  private makeHeaders(extra: Record<string, string> = {}): HeadersInit {
    const token = this.getToken()
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra,
    }
  }

  private resolve(path: string): string {
    if (!this.baseUrl) return path
    return `${this.baseUrl}${path}`
  }
}
