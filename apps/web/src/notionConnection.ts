// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Connexion a Notion depuis la version bureau (ADR-035).
//
// La personne autorise Savoire dans son navigateur, sur la page de Notion
// (elle s'y connecte et choisit les pages a partager). Le serveur Savoire
// fait l'echange du code et renvoie le navigateur sur l'ecoute locale de
// l'application (oauth.rs) avec un ticket. La coquille Rust reprend le jeton
// avec ce ticket et notre « verifier » PKCE, et le garde (notion.rs) : la
// page ne le voit jamais.
//
// Seulement sur le bureau : dans le navigateur, l'API de Notion n'accepte
// pas les appels d'une page web (CORS), et le jeton n'aurait pas d'endroit sur.
import type { NotionApiPort, NotionFilePort, NotionHttpReply } from '@savoire/application'
import { getServerBaseUrl } from '@savoire/infrastructure-sync'
import { isAndroidRuntime, isTauriRuntime } from './tauriRuntime'

interface TauriInternals { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> }

export interface NotionWorkspace {
  workspaceId: string | null
  workspaceName: string | null
  workspaceIcon: string | null
}

export interface NotionBridge {
  /** L'espace connecte, ou null. */
  status(): Promise<NotionWorkspace | null>
  /** Le serveur propose-t-il la connexion a Notion ? */
  available(): Promise<boolean>
  /** Ouvre la page d'autorisation de Notion et attend le retour. */
  connect(): Promise<NotionWorkspace>
  disconnect(): Promise<void>
  api: NotionApiPort
  files: NotionFilePort
}

/** Attente du retour du navigateur (la personne choisit ses pages). */
const CONNECT_TIMEOUT_SECS = 900

function randomToken(bytes: number): string {
  const a = new Uint8Array(bytes)
  crypto.getRandomValues(a)
  return base64Url(a)
}

function base64Url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Defi PKCE S256 d'un verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

/** Le retour du navigateur, dit en clair. */
export function connectError(query: URLSearchParams): string | null {
  const error = query.get('error')
  if (!error) return null
  if (error === 'access_denied') return 'Autorisation annulée dans Notion.'
  if (error === 'busy') return 'Le serveur est trop occupé : réessayez dans un instant.'
  const detail = query.get('error_description')
  return detail ? `Notion a refusé la connexion : ${detail}` : `Notion a refusé la connexion (${error}).`
}

/** Le pont de la version bureau, ou null ailleurs. */
export function desktopNotion(scope: unknown = globalThis): NotionBridge | null {
  if (!isTauriRuntime(scope) || isAndroidRuntime()) return null
  const internals = (scope as { __TAURI_INTERNALS__: TauriInternals }).__TAURI_INTERNALS__
  const invoke = (cmd: string, args?: Record<string, unknown>) => internals.invoke(cmd, args)
  const server = () => getServerBaseUrl() || window.location.origin

  return {
    async status() {
      return (await invoke('notion_status')) as NotionWorkspace | null
    },
    async available() {
      try {
        const res = await fetch(`${server()}/api/v1/notion/config`)
        if (!res.ok) return false
        return (await res.json() as { available?: boolean }).available === true
      } catch {
        return false
      }
    },
    async connect() {
      const state = randomToken(24)
      const verifier = randomToken(48)
      const challenge = await pkceChallenge(verifier)
      const port = Number(await invoke('oauth_listen'))
      const base = server()
      const url = `${base}/api/v1/notion/authorize?port=${port}&state=${encodeURIComponent(state)}&challenge=${encodeURIComponent(challenge)}`
      await invoke('open_external', { url })
      const query = new URLSearchParams(String(await invoke('oauth_wait', { timeoutSecs: CONNECT_TIMEOUT_SECS })))
      if (query.get('state') !== state) throw new Error('Réponse inattendue : recommencez la connexion.')
      const failed = connectError(query)
      if (failed) throw new Error(failed)
      const ticket = query.get('ticket')
      if (!ticket) throw new Error('Réponse sans autorisation : recommencez la connexion.')
      return (await invoke('notion_connect', { server: base, ticket, state, verifier })) as NotionWorkspace
    },
    async disconnect() {
      await invoke('notion_disconnect')
    },
    api: {
      async request(method, path, body) {
        return (await invoke('notion_api', { method, path, body: body === undefined ? null : JSON.stringify(body) })) as NotionHttpReply
      },
    },
    files: {
      async download(url) {
        const raw = await invoke('notion_download', { url })
        return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
      },
    },
  }
}
