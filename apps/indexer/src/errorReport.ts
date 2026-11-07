// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Suivi des erreurs du pair : chaque ligne de journal de niveau `error` part
// aussi a GlitchTip (protocole « enveloppe » de Sentry), sans bibliotheque.
// Le journal ne contient jamais de jeton ni de contenu de note (log.ts) :
// le rapport non plus. Un envoi qui echoue est oublie, jamais rejoue.
import { randomUUID } from 'node:crypto'
import type { LogSink } from './log'

export interface ErrorReportOptions {
  dsn: string
  environment: string
  release: string
  serverName: string
  /** Envoi (remplacable dans les tests). */
  send?: (url: string, headers: Record<string, string>, body: string) => Promise<unknown>
  /** Rapports au plus par minute, pour ne pas noyer GlitchTip dans une avalanche. */
  maxPerMinute?: number
}

export interface ParsedDsn { url: string; key: string }

/** `https://cle@hote/projet` -> adresse d'envoi et cle ; null si illisible. */
export function parseDsn(dsn: string): ParsedDsn | null {
  let u: URL
  try { u = new URL(dsn) } catch { return null }
  const project = u.pathname.replace(/\/+$/, '').split('/').pop() ?? ''
  if (!u.username || !/^\d+$/.test(project)) return null
  const prefix = u.pathname.replace(/\/+$/, '').slice(0, -project.length).replace(/\/+$/, '')
  return { url: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, key: decodeURIComponent(u.username) }
}

/** L'evenement Sentry d'une ligne de journal JSON (log.ts). */
export function eventOf(line: string, opts: Pick<ErrorReportOptions, 'environment' | 'release' | 'serverName'>): Record<string, unknown> | null {
  let entry: Record<string, unknown>
  try { entry = JSON.parse(line) as Record<string, unknown> } catch { return null }
  if (entry['level'] !== 'error') return null
  const { t, level: _level, msg, err, ...rest } = entry
  const e = (err && typeof err === 'object' ? err : null) as { name?: unknown; message?: unknown } | null
  return {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: typeof t === 'string' ? t : new Date().toISOString(),
    platform: 'node',
    level: 'error',
    logger: 'savoire-indexer',
    environment: opts.environment,
    release: opts.release,
    server_name: opts.serverName,
    message: { formatted: String(msg ?? '') },
    ...(e ? { exception: { values: [{ type: String(e.name ?? 'Error'), value: `${String(msg ?? '')} : ${String(e.message ?? '')}` }] } } : {}),
    extra: rest,
  }
}

/** Un puits de journal qui ecrit, puis envoie les erreurs. */
export function withErrorReports(sink: LogSink, opts: ErrorReportOptions): LogSink {
  const target = parseDsn(opts.dsn)
  if (!target) return sink
  const send = opts.send ?? ((url, headers, body) => fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) }))
  const max = opts.maxPerMinute ?? 30
  let windowStart = 0
  let sent = 0
  return line => {
    sink(line)
    if (!line.includes('"level":"error"')) return
    const now = Date.now()
    if (now - windowStart > 60_000) { windowStart = now; sent = 0 }
    if (sent >= max) return
    const event = eventOf(line, opts)
    if (!event) return
    sent++
    const body = `${JSON.stringify({ event_id: event['event_id'], sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
    void Promise.resolve()
      .then(() => send(target.url, {
        'content-type': 'application/x-sentry-envelope',
        'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=savoire-indexer/1`,
      }, body))
      .catch(() => { /* GlitchTip absent : le journal suffit */ })
  }
}
