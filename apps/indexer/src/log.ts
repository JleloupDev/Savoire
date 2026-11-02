// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jean Leloup
//
// Journal structure : une ligne JSON par evenement, sur la sortie standard
// (collectee par Docker, Loki, CloudWatch...). Champs communs : t (ISO),
// level, msg, svc, instance ; puis ceux de l'evenement. Jamais de jeton ni
// de contenu de note dans le journal.
import { errorInfo } from './util'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }

export type LogFields = Record<string, unknown>

export interface Logger {
  debug(msg: string, fields?: LogFields): void
  info(msg: string, fields?: LogFields): void
  warn(msg: string, fields?: LogFields): void
  error(msg: string, fields?: LogFields): void
  child(fields: LogFields): Logger
  enabled(level: LogLevel): boolean
}

export type LogSink = (line: string) => void

const stdout: LogSink = line => { process.stdout.write(line + '\n') }

export function createLogger(level: LogLevel, base: LogFields = {}, sink: LogSink = stdout): Logger {
  const min = RANK[level]
  const write = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: LogFields) => {
    if (RANK[lvl] < min) return
    const entry: LogFields = { t: new Date().toISOString(), level: lvl, msg, ...base }
    if (fields) {
      for (const [k, v] of Object.entries(fields)) entry[k] = v instanceof Error ? errorInfo(v) : v
    }
    let line: string
    try {
      line = JSON.stringify(entry)
    } catch {
      line = JSON.stringify({ t: entry['t'], level: lvl, msg, ...base, note: 'champs illisibles' })
    }
    sink(line)
  }
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: fields => createLogger(level, { ...base, ...fields }, sink),
    enabled: lvl => RANK[lvl] >= min,
  }
}
